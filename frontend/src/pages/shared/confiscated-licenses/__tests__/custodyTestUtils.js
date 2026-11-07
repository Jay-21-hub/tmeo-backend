// Test-only helpers for the Confiscated Licenses module (fixtures + a URL router
// for the mocked axios client). Not imported by any runtime code.

export const row = (o = {}) => ({
  key: 'v1', record_kind: 'active', ticket_number: 'OVR-2024-00123', owner_name: 'JUAN DELA CRUZ',
  license_number: 'D01-23-456789', date_confiscated: '2024-01-12T02:30:00Z', status: 'confiscated',
  doc_type_status: 'not_required', document_type_unverified: false, legacy: false, version: 0, released_at: null,
  ...o,
})

export const detailOf = (o = {}) => ({
  key: 'v1', record_kind: 'active', ticket_number: 'OVR-2024-00123', owner_name: 'JUAN DELA CRUZ',
  license_number: 'D01-23-456789', date_confiscated: '2024-01-12T02:30:00Z',
  violations: ['Reckless Driving'], notes: '', status: 'confiscated', doc_type_status: 'not_required',
  document_type_unverified: false, legacy: false, version: 0, custody_id: null,
  ready_marked_at: null, ready_marked_by: '', release: null, can_correct: true,
  ...o,
})

export const SUMMARY = { total: 12, confiscated: 7, pending_release: 3, released: 2, legacy_unverified: 1 }

export const listBody = (results, count = results.length, summary = SUMMARY) => ({
  count, page: 1, page_size: 10, summary, results,
})

export const apiError = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } })

/** Route the mocked axios `get` by URL. A handler may be data, a function, or a rejected promise. */
export function routeGet(get, handlers = {}) {
  get.mockImplementation((url, cfg) => {
    let h
    if (url.endsWith('/summary/')) h = handlers.summary
    else if (url.endsWith('/timeline/')) h = handlers.timeline
    else if (url.endsWith('/confiscated-licenses/')) h = handlers.list
    else h = handlers.detail
    if (h === undefined) return Promise.reject(new Error(`unrouted GET ${url}`))
    try {
      const v = typeof h === 'function' ? h(url, cfg) : h
      return v instanceof Promise ? v : Promise.resolve({ data: v })
    } catch (e) {
      return Promise.reject(e)
    }
  })
}

/** Params of the most recent call to the list endpoint. */
export const lastListParams = (get) => {
  const calls = get.mock.calls.filter(([u]) => u.endsWith('/confiscated-licenses/'))
  return calls.length ? calls[calls.length - 1][1].params : undefined
}

export const lastSummaryParams = (get) => {
  const calls = get.mock.calls.filter(([u]) => u.endsWith('/summary/'))
  return calls.length ? calls[calls.length - 1][1].params : undefined
}