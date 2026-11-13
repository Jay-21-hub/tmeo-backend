import { useEffect, useMemo, useState } from 'react'
import { Radio, ChevronLeft, ChevronRight } from 'lucide-react'
import { fetchPublicViolations } from '../../services/publicApi'
import { EmptyState, ErrorState, LoadingRows } from '../../components/ui'
import PublicViolationCard from './PublicViolationCard'
import ViolationDetailModal from './ViolationDetailModal'
import tmeoBg from '../../assets/tmeo-office.jpg'

const PAGE_SIZE = 12

export default function ViolationUpdatesPage() {
  const [page, setPage] = useState(1)
  const [violationType, setViolationType] = useState('')
  const [knownTypes, setKnownTypes] = useState([])
  const [selected, setSelected] = useState(null)
  const [state, setState] = useState({ loading: true, error: false, results: [], count: 0, next: null, previous: null })

  const params = useMemo(() => {
    const p = { page, page_size: PAGE_SIZE }
    if (violationType) p.violation_type = violationType
    return p
  }, [page, violationType])

  const load = () => {
    setState((s) => ({ ...s, loading: true, error: false }))
    fetchPublicViolations(params)
      .then((data) => {
        setState({
          loading: false, error: false,
          results: data.results || [], count: data.count || 0,
          next: data.next, previous: data.previous,
        })
        setKnownTypes((prev) => {
          const names = new Set(prev)
          for (const r of data.results || []) {
            if (r.name) names.add(r.name)
          }
          return Array.from(names).sort()
        })
      })
      .catch(() => setState({ loading: false, error: true, results: [], count: 0, next: null, previous: null }))
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-filter-change pattern, matches existing codebase convention
    load()
  }, [params]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(state.count / PAGE_SIZE))

  const resetToPage1 = (setter) => (e) => { setter(e.target.value); setPage(1) }

  return (
    <div className="pub-page">
      <section className="pub-page-hero">
        <div className="pub-hero-bg" aria-hidden="true" style={{ '--pub-photo-bg': `url(${tmeoBg})` }} />
        <div className="pub-hero-scrim" aria-hidden="true" />
        <div className="pub-page-hero-inner">
          <span className="pub-eyebrow pub-eyebrow--light"><span className="pub-eyebrow-rule" aria-hidden="true" />Violation Updates</span>
          <h1 className="pub-page-title">Public Violation Records</h1>
          <p className="pub-page-lede">
            Public-safe traffic violation activity, updated automatically as records are
            finalized. Personal, vehicle, and enforcement details are never shown here.
          </p>
        </div>
      </section>

      <section className="pub-section" style={{ background: "var(--paper)" }}>
        <div className="pub-section-inner">
          <div className="pub-filters">
            <div className="pub-filter-field">
              <label htmlFor="pf-type" className="text-label">Violation type</label>
              <select id="pf-type" value={violationType} onChange={resetToPage1(setViolationType)}>
                <option value="">All types</option>
                {knownTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {state.loading && (
            <div className="pub-vgrid">
              {Array.from({ length: 8 }).map((_, i) => (
                <div className="pub-vcard pub-vcard--skeleton" key={i}><LoadingRows rows={3} /></div>
              ))}
            </div>
          )}

          {!state.loading && state.error && (
            <div className="pub-panel">
              <ErrorState title="Unable to load violation updates" message="Please try again later." onRetry={load} />
            </div>
          )}

          {!state.loading && !state.error && state.results.length === 0 && (
            <div className="pub-panel">
              <EmptyState
                icon={Radio}
                title="No public violation updates are currently available"
                message="Try adjusting your filters, or check back later."
              />
            </div>
          )}

          {!state.loading && !state.error && state.results.length > 0 && (
            <>
              <div className="pub-vgrid">
                {state.results.map((r, i) => (
                  <PublicViolationCard key={i} record={r} index={i} onSelect={setSelected} />
                ))}
              </div>

              <div className="pub-pagination">
                <button
                  type="button" className="btn btn-secondary btn-sm"
                  disabled={!state.previous} onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={15} strokeWidth={2.2} aria-hidden="true" /> Previous
                </button>
                <span className="text-caption">Page {page} of {totalPages}</span>
                <button
                  type="button" className="btn btn-secondary btn-sm"
                  disabled={!state.next} onClick={() => setPage((p) => p + 1)}
                >
                  Next <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      <ViolationDetailModal open={!!selected} onClose={() => setSelected(null)} record={selected} />
    </div>
  )
}