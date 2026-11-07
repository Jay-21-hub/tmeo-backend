// @vitest-environment node
// Regression guard: the frontend must not hold persistent SSE connections
// (each one pinned a Render/gunicorn thread for as long as the tab was open).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

describe('no persistent SSE connections in the frontend', () => {
  const files = walk(SRC).filter((p) => /\.(js|jsx)$/.test(p) && !/\.test\.(js|jsx)$/.test(p))

  it('no source file creates an EventSource', () => {
    const offenders = files.filter((p) => /new\s+EventSource\s*\(/.test(readFileSync(p, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the old SSE hook is gone', () => {
    expect(existsSync(join(SRC, 'hooks/useViolationSSE.js'))).toBe(false)
  })
})