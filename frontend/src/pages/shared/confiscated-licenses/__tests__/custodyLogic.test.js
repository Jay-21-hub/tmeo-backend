// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../../../services/api', () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a) },
}))

import {
  buildListParams, canAccessCustody, describeEventDetails,
  eventLabel, getActionAvailability, hasActiveFilters, tabsForRole, DEFAULT_FILTERS,
} from '../utils/custodyConfig'
import { parseCustodyError } from '../utils/custodyErrors'
import { createRequestIdTracker, newRequestId } from '../services/custodyIdempotency'
import * as custodyApi from '../services/custodyApi'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const rec = (o = {}) => ({
  key: 'v1', status: 'confiscated', doc_type_status: 'not_required', can_correct: true, version: 0, ...o,
})
const apiErr = (status, data) => ({ response: { status, data } })

describe('access and tabs', () => {
  it('allows only admin and staff', () => {
    expect(canAccessCustody('admin')).toBe(true)
    expect(canAccessCustody('staff')).toBe(true)
    expect(canAccessCustody('enforcer')).toBe(false)
    expect(canAccessCustody(undefined)).toBe(false)
  })

  it('offers "All Records" to admin only and uses the real backend status values', () => {
    expect(tabsForRole('staff').map((t) => t.key)).toEqual(['confiscated', 'ready_for_release', 'released'])
    expect(tabsForRole('admin').map((t) => t.key)).toEqual(['confiscated', 'ready_for_release', 'released', 'all'])
  })
})

describe('buildListParams', () => {
  it('sends only supported params and omits empty ones', () => {
    expect(buildListParams(DEFAULT_FILTERS, 'staff')).toEqual({ status: 'confiscated', page: 1, page_size: 10 })
  })

  it('maps every filter to its backend name', () => {
    const f = { ...DEFAULT_FILTERS, tab: 'released', search: '  maria ', dateFrom: '2024-01-01', dateTo: '2024-01-31', legacy: 'only', page: 3 }
    expect(buildListParams(f, 'staff')).toEqual({
      search: 'maria', status: 'released', date_from: '2024-01-01', date_to: '2024-01-31', legacy: 'only', page: 3, page_size: 10,
    })
  })

  it('"All Records" sends no status; include_excluded is admin-only', () => {
    const f = { ...DEFAULT_FILTERS, tab: 'all', includeExcluded: true }
    expect(buildListParams(f, 'admin').status).toBeUndefined()
    expect(buildListParams(f, 'admin').include_excluded).toBe('1')
    expect(buildListParams(f, 'staff').include_excluded).toBeUndefined()
  })

  it('summary params drop status and paging so tab counts stay independent of the tab', () => {
    const p = buildListParams({ ...DEFAULT_FILTERS, tab: 'released', search: 'x' }, 'staff', { includeStatus: false, paged: false })
    expect(p).toEqual({ search: 'x' })
  })

  it('ignores an unsupported legacy value', () => {
    expect(buildListParams({ ...DEFAULT_FILTERS, legacy: 'bogus' }, 'staff').legacy).toBeUndefined()
  })

  it('detects active filters (the tab alone is not a filter)', () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false)
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, search: ' a ' })).toBe(true)
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, includeExcluded: true })).toBe(true)
  })
})

describe('getActionAvailability — state and role', () => {
  it('In Custody (normal record): only Mark Ready is available', () => {
    const a = getActionAvailability(rec(), 'staff')
    expect(a.markReady.enabled).toBe(true)
    expect(a.release.enabled).toBe(false)
    expect(a.release.reason).toMatch(/marked ready first/i)
    expect(a.verify.enabled).toBe(false)
  })

  it('Ready: only Release is available (forward-only)', () => {
    const a = getActionAvailability(rec({ status: 'ready_for_release' }), 'staff')
    expect(a.release.enabled).toBe(true)
    expect(a.markReady.enabled).toBe(false)
    expect(a.markReady.reason).toMatch(/already marked ready/i)
  })

  it('Released: nothing is available', () => {
    const a = getActionAvailability(rec({ status: 'released', can_correct: true }), 'admin')
    expect(a.markReady.enabled).toBe(false)
    expect(a.release.enabled).toBe(false)
    expect(a.release.reason).toMatch(/already released/i)
    expect(a.verify.enabled).toBe(false)
  })

  it('pending legacy record: Verify is available, Mark Ready is blocked until verified', () => {
    const a = getActionAvailability(rec({ doc_type_status: 'pending' }), 'staff')
    expect(a.verify.enabled).toBe(true)
    expect(a.markReady.enabled).toBe(false)
    expect(a.markReady.reason).toMatch(/verify the legacy document/i)
  })

  it('confirmed legacy record can proceed; excluded cannot', () => {
    expect(getActionAvailability(rec({ doc_type_status: 'confirmed_drivers_license' }), 'staff').markReady.enabled).toBe(true)
    const ex = getActionAvailability(rec({ doc_type_status: 'excluded' }), 'admin')
    expect(ex.markReady.enabled).toBe(false)
    expect(ex.markReady.reason).toMatch(/excluded/i)
    expect(ex.verify.enabled).toBe(false)
  })

  it('Staff never gets the correction action or the exclusion decision', () => {
    const a = getActionAvailability(rec({ can_correct: true }), 'staff')
    expect(a.correct.visible).toBe(false)
    expect(a.correct.enabled).toBe(false)
    expect(a.canExclude).toBe(false)
  })

  it('Admin gets correction only when the backend says can_correct', () => {
    expect(getActionAvailability(rec({ can_correct: true }), 'admin').correct.enabled).toBe(true)
    const archived = getActionAvailability(rec({ can_correct: false }), 'admin')
    expect(archived.correct.visible).toBe(true)
    expect(archived.correct.enabled).toBe(false)
    expect(archived.correct.reason).toMatch(/archived/i)
    expect(getActionAvailability(rec(), 'admin').canExclude).toBe(true)
  })

  it('any other role (enforcer) gets nothing', () => {
    const a = getActionAvailability(rec(), 'enforcer')
    expect([a.markReady, a.release, a.verify, a.correct].every((x) => !x.visible && !x.enabled)).toBe(true)
  })
})

describe('event helpers', () => {
  it('describes admin details and returns nothing for staff events', () => {
    const rows = describeEventDetails({ details: { reason: 'typo', before: { license_number: 'A' }, after: { license_number: 'B' } } })
    expect(rows).toContainEqual(['Reason', 'typo'])
    expect(rows).toContainEqual(['License number', 'A → B'])
    expect(describeEventDetails({ id: 1 })).toEqual([])
    const rel = describeEventDetails({ details: { released_to_name: 'Juan', claimant_id_type: 'passport', claimant_id_last4: '1234', authorization_reference: 'SPA-1' } })
    expect(rel).toContainEqual(['Claimant ID', 'Passport ••••1234'])
  })

  it('labels known and unknown event types', () => {
    expect(eventLabel('marked_ready')).toBe('Marked ready for release')
    expect(eventLabel('something_new')).toBe('Something new')
  })
})

describe('parseCustodyError', () => {
  it('payment_required (409) is a known, non-stale inline error', () => {
    const e = parseCustodyError(apiErr(409, { code: 'payment_required', detail: 'x' }), { write: true })
    expect(e.code).toBe('payment_required')
    expect(e.message).toMatch(/must be paid/i)
    expect(e.stale).toBe(false)
  })

  it('version_conflict is stale and exposes current_version', () => {
    const e = parseCustodyError(apiErr(409, { code: 'version_conflict', detail: 'Reload and try again.', current_version: 4 }))
    expect(e.stale).toBe(true)
    expect(e.currentVersion).toBe(4)
    expect(e.message).not.toMatch(/reload/i)
  })

  it.each([
    'invalid_transition', 'already_released', 'not_ready', 'document_type_unverified',
    'record_excluded', 'verification_not_pending', 'archived_locked',
  ])('%s is treated as stale', (code) => {
    expect(parseCustodyError(apiErr(409, { code, detail: 'd' })).stale).toBe(true)
  })

  it('no_change and admin_required stay inline (not stale)', () => {
    expect(parseCustodyError(apiErr(409, { code: 'no_change', detail: 'd' })).stale).toBe(false)
    const a = parseCustodyError(apiErr(403, { code: 'admin_required', detail: 'd' }))
    expect(a.stale).toBe(false)
    expect(a.status).toBe(403)
  })

  it('maps DRF field validation (400) to known fields; unknown fields go to the message', () => {
    const e = parseCustodyError(apiErr(400, { reason: ['This field is required.'], client_request_id: ['Must be a valid UUID.'] }), { fields: ['reason'] })
    expect(e.code).toBe('validation_error')
    expect(e.fieldErrors).toEqual({ reason: 'This field is required.' })
    expect(e.message).toMatch(/valid UUID/)
  })

  it('shows a generic message when every 400 error maps to a field', () => {
    const e = parseCustodyError(apiErr(400, { reason: ['Required.'] }), { fields: ['reason'] })
    expect(e.message).toMatch(/correct the highlighted fields/i)
  })

  it('handles permission 403 without a code, 404, 429 and 401', () => {
    expect(parseCustodyError(apiErr(403, { detail: 'You do not have permission to perform this action.' })).code).toBe('permission_denied')
    const nf = parseCustodyError(apiErr(404, { code: 'not_found', detail: 'x' }))
    expect(nf.stale).toBe(true)
    expect(parseCustodyError(apiErr(404, {})).code).toBe('not_found')
    expect(parseCustodyError(apiErr(429, { detail: 'Throttled' })).code).toBe('throttled')
    expect(parseCustodyError(apiErr(401, {})).code).toBe('unauthenticated')
  })

  it('network failures on writes say the outcome is unknown and retry is safe', () => {
    const w = parseCustodyError({ message: 'Network Error' }, { write: true })
    expect(w.network).toBe(true)
    expect(w.unknownOutcome).toBe(true)
    expect(w.message).toMatch(/may not have been saved/i)
    const r = parseCustodyError({ message: 'Network Error' })
    expect(r.unknownOutcome).toBe(false)
  })

  it('5xx never leaks server text', () => {
    const e = parseCustodyError(apiErr(500, { detail: 'Traceback ... secret' }), { write: true })
    expect(e.message).not.toMatch(/secret|Traceback/)
    expect(e.unknownOutcome).toBe(true)
  })

  it('an unknown code uses the server text when present, else a generic message', () => {
    expect(parseCustodyError(apiErr(409, { code: 'brand_new', detail: 'Server says hi' })).message).toBe('Server says hi')
    expect(parseCustodyError(apiErr(409, { code: 'brand_new' })).message).toMatch(/something went wrong/i)
  })
})

describe('client_request_id tracker', () => {
  it('generates UUID v4 values', () => {
    expect(newRequestId()).toMatch(UUID)
  })

  it('reuses the id for an identical retry and issues a new one when content changes', () => {
    const t = createRequestIdTracker()
    const a = t.idFor({ version: 1, values: { reason: 'x' } })
    expect(t.idFor({ version: 1, values: { reason: 'x' } })).toBe(a)
    const b = t.idFor({ version: 1, values: { reason: 'y' } })
    expect(b).not.toBe(a)
    expect(t.idFor({ version: 2, values: { reason: 'y' } })).not.toBe(b)
  })

  it('reset() forces a fresh id', () => {
    const t = createRequestIdTracker()
    const a = t.idFor({ v: 1 })
    t.reset()
    expect(t.idFor({ v: 1 })).not.toBe(a)
  })
})

describe('custodyApi — real endpoints and exact request fields', () => {
  beforeEach(() => { get.mockReset(); post.mockReset(); get.mockResolvedValue({}); post.mockResolvedValue({}) })
  const meta = { expectedVersion: 3, clientRequestId: 'abc' }

  it('read endpoints', () => {
    custodyApi.fetchCustodyList({ page: 1 }, 'S')
    custodyApi.fetchCustodySummary({ q: 1 }, 'S')
    custodyApi.fetchCustodyDetail('v12', 'S')
    custodyApi.fetchCustodyTimeline('a7', 'S')
    expect(get.mock.calls).toEqual([
      ['/api/violations/confiscated-licenses/', { params: { page: 1 }, signal: 'S' }],
      ['/api/violations/confiscated-licenses/summary/', { params: { q: 1 }, signal: 'S' }],
      ['/api/violations/confiscated-licenses/v12/', { signal: 'S' }],
      ['/api/violations/confiscated-licenses/a7/timeline/', { signal: 'S' }],
    ])
  })

  it('mark-ready sends only expected_version and client_request_id', () => {
    custodyApi.markReady('v1', meta)
    expect(post).toHaveBeenCalledWith('/api/violations/confiscated-licenses/v1/mark-ready/', { expected_version: 3, client_request_id: 'abc' })
  })

  it('release sends exactly the serializer fields', () => {
    custodyApi.releaseLicense('v1', meta, {
      releasedToName: 'Juan', claimantIdType: 'passport', claimantIdLast4: '1234', authorizationReference: 'SPA-1', releaseRemarks: 'ok',
    })
    expect(post).toHaveBeenCalledWith('/api/violations/confiscated-licenses/v1/release/', {
      expected_version: 3, client_request_id: 'abc', released_to_name: 'Juan', claimant_id_type: 'passport',
      claimant_id_last4: '1234', authorization_reference: 'SPA-1', release_remarks: 'ok',
    })
  })

  it('verify and correct send exactly their serializer fields', () => {
    custodyApi.verifyDocumentType('v1', meta, { decision: 'drivers_license', reason: 'seen' })
    custodyApi.correctLicenseNumber('v1', meta, { licenseNumber: 'D1-2', reason: 'typo' })
    expect(post.mock.calls[0]).toEqual(['/api/violations/confiscated-licenses/v1/verify-document-type/', { expected_version: 3, client_request_id: 'abc', decision: 'drivers_license', reason: 'seen' }])
    expect(post.mock.calls[1]).toEqual(['/api/violations/confiscated-licenses/v1/correct/', { expected_version: 3, client_request_id: 'abc', license_number: 'D1-2', reason: 'typo' }])
  })
})