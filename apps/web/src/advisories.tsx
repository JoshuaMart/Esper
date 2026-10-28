import { useEffect, useState } from 'react'
import { type Advisory, type AdvisoryReport, api, type Job } from './api.ts'
import { useProject } from './app.tsx'
import {
  formatDate,
  formatShortDate,
  href,
  Link,
  navigate,
  shortCommit,
  shortRef,
  snapshotLabel,
  useData,
  useLive,
  useLocation,
  withParams,
} from './lib.tsx'
import { AdvisoryStateBadge, ErrorNotice, Icon, SeverityBadge, Spinner, TopBar } from './ui.tsx'

// The target's past advisories (D19), as the snapshot being read stands against them: each with
// its severity, whether this version is affected or fixed, how it was linked to the code, and the
// nodes it affects here. Advisory text comes from a third party: it is shown as text.

const severities = ['critical', 'high', 'moderate', 'unrated'] as const
const precisions = ['symbol', 'fix-diff', 'file', 'unlinked'] as const

const codeWords = {
  'as-fixed': 'as the fix left it',
  'as-before-fix': 'as it was before the fix',
  changed: 'changed since the fix',
}

export function AdvisoriesPage({ project }: { project: string }) {
  const p = useProject(project)
  const { params } = useLocation()
  const severity = params.get('severity') ?? undefined
  const state = params.get('state') ?? undefined
  const precision = params.get('precision') ?? undefined
  const id = params.get('id') ?? undefined
  const set = (changes: Record<string, string | undefined>) =>
    navigate(withParams(changes), { replace: true })
  const filters = { severity, state, precision }
  const list = useData(
    p.snapshot
      ? `${project}:${p.snapshot}:advisories:${JSON.stringify(filters)}:${p.version}`
      : undefined,
    () => api.advisories(project, { snapshot: p.snapshot, limit: 200, ...filters }),
  )
  const snapshot = p.snapshots?.find((s) => s.id === p.snapshot)
  const fetched = list.data?.fetched
  const advisories = (list.data?.advisories ?? []).filter((a) => !id || a.id === id)

  return (
    <>
      <TopBar
        project={project}
        {...(p.projects ? { projects: p.projects } : {})}
        {...(p.snapshots ? { snapshots: p.snapshots } : {})}
        {...(p.snapshot !== undefined ? { snapshot: p.snapshot } : {})}
        latest={p.latest}
        current="advisories"
      />
      <main className="page">
        <div className="head">
          <div className="stack">
            <h1 className="h1">
              Past advisories{' '}
              {list.data ? (
                <span className="muted" style={{ fontWeight: 400 }}>
                  {list.data.total}
                </span>
              ) : null}
            </h1>
            <p className="muted" style={{ margin: 0 }}>
              {fetched
                ? `From OSV on ${formatDate(fetched.at)}, for ${fetched.packages
                    .map((pkg) => pkg.name)
                    .join(', ')}; ${fetched.low} rated low left out.`
                : 'Not fetched from OSV yet.'}{' '}
              {snapshot ? `Placed on ${snapshotLabel(snapshot)}.` : ''}
            </p>
          </div>
          <FetchAgain project={project} />
        </div>

        <form
          className="row"
          style={{ gap: 12 }}
          aria-label="Filters"
          onSubmit={(e) => e.preventDefault()}
        >
          <fieldset className="seg" aria-label="Severity">
            <button
              type="button"
              aria-pressed={!severity}
              onClick={() => set({ severity: undefined, id: undefined })}
            >
              All
            </button>
            {severities.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={severity === s}
                onClick={() => set({ severity: s, id: undefined })}
              >
                {`${s[0]?.toUpperCase()}${s.slice(1)}`}
              </button>
            ))}
          </fieldset>
          <label className="row" style={{ gap: 6 }}>
            <span className="muted">This version</span>
            <select
              className="input"
              value={state ?? ''}
              onChange={(e) => set({ state: e.target.value || undefined, id: undefined })}
            >
              <option value="">Any</option>
              <option value="affected">affected</option>
              <option value="fixed">fixed</option>
              <option value="unaffected">unaffected</option>
              <option value="unknown">unknown</option>
            </select>
          </label>
          <label className="row" style={{ gap: 6 }}>
            <span className="muted">Linked by</span>
            <select
              className="input"
              value={precision ?? ''}
              onChange={(e) => set({ precision: e.target.value || undefined, id: undefined })}
            >
              <option value="">Any</option>
              {precisions.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          {id ? (
            <button type="button" className="link" onClick={() => set({ id: undefined })}>
              Show every advisory, not only {id}
            </button>
          ) : null}
        </form>

        {list.error ? <ErrorNotice error={list.error} /> : null}
        {!list.data && !list.error ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : null}
        {list.data && advisories.length === 0 ? (
          <p className="muted">
            {fetched
              ? 'No advisory matches.'
              : 'Esper fetches advisories when it indexes, unless offline; Fetch again asks OSV now.'}
          </p>
        ) : null}
        {advisories.length > 0 ? (
          <section className="card" aria-label="Advisories">
            {advisories.map((a) => (
              <AdvisoryItem key={a.id} project={project} advisory={a} snapshot={p.asked} />
            ))}
          </section>
        ) : null}
        {list.data?.truncated ? (
          <p className="muted" style={{ margin: 0 }}>
            {list.data.cut.join('; ')}
          </p>
        ) : null}
      </main>
    </>
  )
}

function AdvisoryItem({
  project,
  advisory: a,
  snapshot,
}: {
  project: string
  advisory: Advisory
  snapshot: number | undefined
}) {
  const [open, setOpen] = useState(false)
  return (
    <article className="advisory" aria-labelledby={`adv-${a.id}`}>
      <div className="row" style={{ gap: 8 }}>
        <SeverityBadge severity={a.severity} />
        <AdvisoryStateBadge state={a.state} />
        <h2 className="h2 mono" id={`adv-${a.id}`} style={{ fontSize: '0.875rem' }}>
          {a.id}
        </h2>
        {a.aliases.length > 0 ? (
          <span className="mono muted" style={{ fontSize: '0.75rem' }}>
            {a.aliases.join(', ')}
          </span>
        ) : null}
        <a
          className="link"
          style={{ marginInlineStart: 'auto', fontSize: '0.75rem' }}
          href={`https://osv.dev/vulnerability/${encodeURIComponent(a.id)}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          On OSV <Icon name="external" size={12} />
        </a>
      </div>
      <p className="summary">{a.summary || 'No summary.'}</p>
      <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
        This version is {a.state} ({a.stateHow}).{' '}
        {a.status === 'unlinked'
          ? `Not linked to the code: ${a.how}.`
          : `Linked by ${a.how}${a.fixes.length > 0 ? `, fix ${a.fixes.map(shortCommit).join(', ')}` : ''}.`}
        {a.unplaced > 0
          ? ` ${a.unplaced} ${a.unplaced === 1 ? 'link is' : 'links are'} on code this snapshot does not hold.`
          : ''}
      </p>
      {a.links.length > 0 ? (
        <ul className="stack" style={{ gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
          {a.links.map((l) => (
            <li key={l.node} className="row" style={{ gap: 8 }}>
              <span className="chip">{l.precision}</span>
              <Link
                className="link mono"
                style={{ fontSize: '0.8125rem' }}
                to={href(`/p/${encodeURIComponent(project)}/entry`, {
                  node: l.node,
                  snapshot,
                })}
              >
                {shortRef(l.node)}
              </Link>
              {l.code ? <span className="muted">{codeWords[l.code]}</span> : null}
              {l.movedFrom ? (
                <span className="muted">
                  moved from <span className="mono">{shortRef(l.movedFrom)}</span>
                </span>
              ) : null}
              {l.hunk ? (
                <span className="mono muted" style={{ fontSize: '0.75rem' }}>
                  fix at {l.hunk}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        className="link"
        style={{ alignSelf: 'flex-start', fontSize: '0.8125rem' }}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide the details' : 'Details and references'}
      </button>
      {open ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
            {a.package.name} ({a.package.ecosystem})
            {a.published ? ` · published ${formatShortDate(a.published)}` : ''}
            {a.rating
              ? ` · rated by ${a.rating.from}${a.rating.score !== undefined ? `, CVSS ${a.rating.score}` : ''}`
              : ''}
          </p>
          {a.details ? (
            <pre className="box" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 320 }}>
              {a.details}
            </pre>
          ) : null}
          <ul className="stack" style={{ gap: 2, margin: 0, paddingInlineStart: 18 }}>
            {a.references.map((r) => (
              <li key={r.url} style={{ fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>
                <span className="muted">{r.type.toLowerCase()} </span>
                <a className="link" href={r.url} target="_blank" rel="noreferrer noopener">
                  {r.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  )
}

// Asks the server to fetch the advisories from OSV again, as a job, and says how it went.
function FetchAgain({ project }: { project: string }) {
  const { jobs } = useLive()
  const [jobId, setJobId] = useState<number>()
  const [error, setError] = useState<string>()
  const job: Job | undefined = jobId !== undefined ? jobs.get(jobId) : undefined
  const running = jobId !== undefined && (!job || job.state === 'running')
  useEffect(() => {
    if (job?.state === 'failed') setError(job.error)
  }, [job])
  const report = job?.state === 'done' ? (job.result as AdvisoryReport) : undefined
  return (
    <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
      <button
        type="button"
        className="btn"
        disabled={running}
        onClick={async () => {
          setError(undefined)
          try {
            setJobId((await api.fetchAdvisories(project)).job.id)
          } catch (e) {
            setError((e as Error).message)
          }
        }}
      >
        {running ? <Spinner /> : <Icon name="refresh" />}
        Fetch again
      </button>
      <span className="muted" role="status" style={{ fontSize: '0.75rem' }}>
        {error
          ? error
          : running
            ? 'Asking OSV and linking…'
            : report
              ? `${report.advisories} kept, ${report.unlinked} unlinked, ${report.low} low left out`
              : ''}
      </span>
    </div>
  )
}
