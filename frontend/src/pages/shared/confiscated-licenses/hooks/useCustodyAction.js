import { useCallback, useEffect, useRef, useState } from 'react'
import { createRequestIdTracker } from '../services/custodyIdempotency'
import { parseCustodyError } from '../utils/custodyErrors'

/**
 * Shared submit logic for the four custody write actions.
 *
 *  - blocks duplicate submissions synchronously (a ref, not just state, so two
 *    clicks in the same tick cannot both go out);
 *  - sends the record's `version` as expected_version and a client_request_id
 *    that is reused only when the exact same content is retried;
 *  - on success hands the backend response to `onSuccess` and LEAVES the
 *    dialog locked: `onSuccess` must close it (the parent unmounts the modal);
 *  - on a stale-state error (version conflict, already released, ...) calls
 *    `onStale(parsedError)`; every other error stays in the dialog as `error`.
 *
 * @param record     the custody record the dialog was opened for ({ key, version })
 * @param call       (key, { expectedVersion, clientRequestId }, values) => axios promise
 * @param fields     form field names, so 400 field errors can be shown per field
 */
export default function useCustodyAction({ record, call, fields, onSuccess, onStale }) {
  const [tracker] = useState(() => createRequestIdTracker())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const busy = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const submit = useCallback(async (values) => {
    if (busy.current) return
    busy.current = true
    setSubmitting(true)
    setError(null)

    const meta = {
      expectedVersion: record.version,
      clientRequestId: tracker.idFor({ key: record.key, version: record.version, values }),
    }

    let res
    try {
      res = await call(record.key, meta, values)
    } catch (err) {
      const parsed = parseCustodyError(err, { fields, write: true })
      if (parsed.code === 'idempotency_conflict') tracker.reset()
      busy.current = false
      if (parsed.stale) {
        onStale(parsed)
      } else if (alive.current) {
        setError(parsed)
        setSubmitting(false)
      }
      return
    }
    // Success: stay locked until the parent closes the dialog.
    onSuccess(res.data)
  }, [record, call, fields, tracker, onSuccess, onStale])

  const clearError = useCallback(() => setError(null), [])

  return { submit, submitting, error, clearError }
}