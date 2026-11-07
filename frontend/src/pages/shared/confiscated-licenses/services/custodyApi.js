// Thin wrappers around the Stage B custody endpoints, using the project's
// authenticated axios client (token attach + refresh live in services/api).
//
// Write endpoints ALL require { expected_version, client_request_id }:
//   * expected_version  - optimistic lock; the record's `version` as last loaded
//   * client_request_id - UUID idempotency key; a repeat with identical content
//                         is replayed (`replayed: true`), never applied twice
import api from '../../../../services/api'
import { API } from '../../../../constants'

export const fetchCustodyList = (params, signal) => api.get(API.CUSTODY_LIST, { params, signal })
export const fetchCustodySummary = (params, signal) => api.get(API.CUSTODY_SUMMARY, { params, signal })
export const fetchCustodyDetail = (key, signal) => api.get(API.CUSTODY_DETAIL(key), { signal })
export const fetchCustodyTimeline = (key, signal) => api.get(API.CUSTODY_TIMELINE(key), { signal })

const base = ({ expectedVersion, clientRequestId }) => ({
  expected_version: expectedVersion,
  client_request_id: clientRequestId,
})

export const markReady = (key, meta) =>
  api.post(API.CUSTODY_MARK_READY(key), base(meta))

export const releaseLicense = (key, meta, f) =>
  api.post(API.CUSTODY_RELEASE(key), {
    ...base(meta),
    released_to_name: f.releasedToName,
    claimant_id_type: f.claimantIdType,
    claimant_id_last4: f.claimantIdLast4,
    authorization_reference: f.authorizationReference,
    release_remarks: f.releaseRemarks,
  })

export const verifyDocumentType = (key, meta, f) =>
  api.post(API.CUSTODY_VERIFY(key), { ...base(meta), decision: f.decision, reason: f.reason })

export const correctLicenseNumber = (key, meta, f) =>
  api.post(API.CUSTODY_CORRECT(key), { ...base(meta), license_number: f.licenseNumber, reason: f.reason })