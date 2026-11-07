// client_request_id handling for custody write actions.
//
// The backend replays a request whose (user, client_request_id) it has already
// committed with IDENTICAL content, and answers `idempotency_conflict` if the
// same id arrives with DIFFERENT content. So:
//   * retrying the exact same submission (e.g. after a dropped connection)
//     must reuse its id  -> a request that did commit is replayed, not doubled;
//   * any change to the content (including the record's version) needs a new id.

export function newRequestId() {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  // RFC 4122 v4 fallback for non-secure contexts where randomUUID is unavailable
  const b = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(b)
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'))
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`
}

export function createRequestIdTracker() {
  let last = null
  return {
    /** Same payload -> same id; different payload -> fresh id. */
    idFor(payload) {
      const fingerprint = JSON.stringify(payload)
      if (!last || last.fingerprint !== fingerprint) last = { fingerprint, id: newRequestId() }
      return last.id
    },
    reset() { last = null },
  }
}