import api from '../services/api'
import { API } from '../constants'

/**
 * Shared license-photo OCR helpers for the camera scanner and the upload
 * panel. Both send the same JSON body the backend already accepts:
 * POST /api/violations/scan-license/ { image: <base64 jpeg, no data-URL prefix> }.
 */

function fittedSize(width, height, maxSide) {
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { width, height }
  const scale = maxSide / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The photo could not be prepared for reading.'))
    img.src = url
  })
}

async function drawableFromBlob(blob) {
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    return {
      width: bitmap.width,
      height: bitmap.height,
      drawable: bitmap,
      cleanup: () => bitmap.close(),
    }
  } catch {
    const url = URL.createObjectURL(blob)
    try {
      const img = await loadImage(url)
      return {
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        drawable: img,
        cleanup: () => URL.revokeObjectURL(url),
      }
    } catch (err) {
      URL.revokeObjectURL(url)
      throw err
    }
  }
}

async function resolveDrawable(source) {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight, drawable: source }
  }
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    return { width: source.width, height: source.height, drawable: source }
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) return drawableFromBlob(source)
  throw new Error('The photo could not be prepared for reading.')
}

/**
 * Draw `source` (canvas, video, or File/Blob) onto a canvas whose longest
 * side is at most `maxSide`, keeping the aspect ratio. Returns the raw
 * base64 JPEG payload (no `data:` prefix) for the scan request.
 */
export async function resizeImageToJpegBase64(source, { maxSide = 1280, quality = 0.85 } = {}) {
  const image = await resolveDrawable(source)
  try {
    if (!image.width || !image.height) {
      throw new Error('The photo could not be prepared for reading.')
    }
    const { width, height } = fittedSize(image.width, image.height, maxSide)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The photo could not be prepared for reading.')
    ctx.drawImage(image.drawable, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    const comma = dataUrl.indexOf(',')
    if (comma < 0) throw new Error('The photo could not be prepared for reading.')
    return dataUrl.slice(comma + 1)
  } finally {
    image.cleanup?.()
  }
}

function serverDetail(data) {
  if (data == null) return ''
  if (typeof data === 'string') {
    const text = data.trim()
    if (!text || text.startsWith('<')) return ''
    return text.slice(0, 300)
  }
  if (typeof data !== 'object') return ''
  const detail = data.detail
  if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 300)
  if (Array.isArray(detail) && detail.length) return detail.map(String).join(' ').slice(0, 300)
  if (typeof data.error === 'string' && data.error.trim()) return data.error.trim().slice(0, 300)
  return ''
}

/** Raw base64 stays as-is. A data URL loses everything through `;base64,`. */
export function imagePayload(value) {
  const raw = String(value ?? '').trim()
  const match = raw.match(/^data:[^,]*;base64,/i)
  return match ? raw.slice(match[0].length) : raw
}

function isClientTimeout(error) {
  const code = error?.code
  const message = String(error?.message || '')
  return code === 'ETIMEDOUT' || (code === 'ECONNABORTED' && /timeout of \d+ms exceeded/i.test(message))
}

/**
 * POST the JPEG. Accepts raw base64 or a data URL. Never throws.
 * This call alone uses a 100s timeout; the shared axios instance is unchanged.
 * That client timeout is `errorKind: 'timeout'`. A dropped connection or a
 * worker killed by the server is `errorKind: 'network'`.
 */
export async function scanLicenseRequest(base64) {
  try {
    const image = imagePayload(base64)
    const res = await api.post(API.SCAN_LICENSE, { image }, { timeout: 100000 })
    const parsed = res.data?.parsed && typeof res.data.parsed === 'object' ? res.data.parsed : {}
    const rawText = typeof res.data?.raw_text === 'string' ? res.data.raw_text : ''
    return { ok: true, status: res.status, parsed, rawText, errorDetail: '', errorKind: null }
  } catch (error) {
    const status = error?.response?.status ?? null
    if (status != null) {
      return {
        ok: false,
        status,
        parsed: null,
        rawText: '',
        errorDetail: serverDetail(error.response?.data),
        errorKind: 'http',
      }
    }
    return {
      ok: false,
      status: null,
      parsed: null,
      rawText: '',
      errorDetail: '',
      errorKind: isClientTimeout(error) ? 'timeout' : 'network',
    }
  }
}

export function hasReadableLicense(parsed) {
  return !!parsed && Object.values(parsed).some(Boolean)
}

/** User-facing line for a failed scan. Empty 200 responses are not failures. */
export function formatScanFailure(result) {
  if (result?.errorKind === 'timeout') {
    return 'The scan timed out before a result came back. Retake the photo with the card flat, in focus and well lit.'
  }
  if (result?.errorKind === 'network') {
    return 'The scan could not reach the server. Check your connection and try again.'
  }
  if (result?.errorKind === 'prepare') {
    return result.errorDetail || 'The photo could not be prepared for reading.'
  }
  const status = result?.status != null ? ` (${result.status})` : ''
  const detail = result?.errorDetail ? `: ${result.errorDetail}` : ''
  return `Scan failed${status}${detail}. Retake the photo with the card flat, in focus and well lit.`
}
