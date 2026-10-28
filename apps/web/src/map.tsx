import { useMemo, useState } from 'react'
import { api, type Entry, type SharedMap } from './api.ts'
import { commonPrefix, groupsBy } from './entries.tsx'
import { href, Link, navigate, shortRef, useData, useLocation, withParams } from './lib.tsx'
import { ErrorNotice, Spinner } from './ui.tsx'

// The map: one group of entry points around the edge, and the code at least `min` of them call
// directly in the middle, each bubble sized by how many call it. Bounded by the group (D14).

const width = 940
const height = 680
const cx = width / 2
const cy = height / 2

interface Placed {
  x: number
  y: number
  a: number
}

function layout(map: SharedMap) {
  const pos = new Map<string, Placed>()
  map.entries.forEach((e, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / map.entries.length
    pos.set(e.ref, { x: cx + 330 * Math.cos(a), y: cy + 285 * Math.sin(a), a })
  })
  // Each shared bubble leans toward the entry points that call it; the inner ring is then spread
  // evenly in that order, so that no two overlap.
  const leaning = map.shared
    .map((s) => {
      let vx = 0
      let vy = 0
      for (const u of s.users) {
        const p = pos.get(u)
        if (p) {
          vx += Math.cos(p.a)
          vy += Math.sin(p.a)
        }
      }
      return { ref: s.ref, a: Math.atan2(vy, vx) }
    })
    .sort((p, q) => p.a - q.a)
  const radius = map.shared.length > 12 ? { x: 200, y: 160 } : { x: 150, y: 120 }
  leaning.forEach((p, i) => {
    const a = (leaning[0]?.a ?? 0) + (i * 2 * Math.PI) / leaning.length
    pos.set(p.ref, {
      x: leaning.length === 1 ? cx : cx + radius.x * Math.cos(a),
      y: leaning.length === 1 ? cy : cy + radius.y * Math.sin(a),
      a,
    })
  })
  return pos
}

export function MapView({
  project,
  snapshot,
  asked,
  entries,
  prefix,
}: {
  project: string
  snapshot: number
  asked: number | undefined
  entries: Entry[]
  prefix: string[]
}) {
  const { params } = useLocation()
  const choices = useMemo(() => {
    const byChain = groupsBy('chain', entries, prefix.length > 0 ? prefix : commonPrefix(entries))
      .filter((g) => g.entries.length >= 2)
      .map((g, i) => ({
        key: `chain:${i}`,
        label: `${g.lead}${g.tail.join(' > ')}`.trim() || 'No chain',
        entries: g.entries,
      }))
    const bySignal = groupsBy('signal', entries, [])
      .filter((g) => g.tail.length > 0)
      .map((g) => ({
        key: `signal:${g.tail[0]}`,
        label: `Signal ${g.tail[0]}`,
        entries: g.entries,
      }))
    const byRead = groupsBy('read', entries, [])
      .filter((g) => g.tail.length > 0)
      .slice(0, 10)
      .map((g) => ({ key: `read:${g.tail[0]}`, label: `Read ${g.tail[0]}`, entries: g.entries }))
    return [...byChain, ...bySignal, ...byRead, { key: 'all', label: 'All entry points', entries }]
  }, [entries, prefix])
  const choice = choices.find((c) => c.key === params.get('group')) ?? choices[0]
  const min = Number(params.get('min') ?? 3)
  const library = params.get('library') ?? 'sinks'
  const set = (changes: Record<string, string | undefined>) =>
    navigate(withParams(changes), { replace: true })

  const tooMany = (choice?.entries.length ?? 0) > 100
  const refs = (choice?.entries ?? []).map((e) => e.ref)
  const map = useData(
    choice && !tooMany
      ? `${project}:${snapshot}:map:${refs.join(',')}:${min}:${library}`
      : undefined,
    () => api.map(project, { entries: refs, min, library, snapshot }),
  )
  const [picked, setPicked] = useState<string>()

  const data = map.data
  const pos = useMemo(() => (data ? layout(data) : new Map<string, Placed>()), [data])
  const selected =
    data &&
    (data.shared.find((s) => s.ref === picked) ?? data.entries.find((e) => e.ref === picked))
  const near = new Set<string>()
  if (data && picked) {
    near.add(picked)
    for (const s of data.shared) {
      if (s.ref === picked) for (const u of s.users) near.add(u)
      if (s.users.includes(picked)) near.add(s.ref)
    }
  }
  const dim = (ref: string) => (picked && !near.has(ref) ? 0.4 : 1)
  const entryLink = (ref: string) =>
    href(`/p/${encodeURIComponent(project)}/entry`, { node: ref, snapshot: asked })

  return (
    <>
      <form
        className="row filters"
        style={{ gap: 16, alignItems: 'flex-end' }}
        aria-label="Map settings"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="field">
          <label htmlFor="m-group">Group</label>
          <select
            id="m-group"
            className="input"
            value={choice?.key}
            onChange={(e) => set({ group: e.target.value })}
            style={{ maxWidth: 520 }}
          >
            {choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label} · {c.entries.length}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="m-min">Shared by at least</label>
          <select
            id="m-min"
            className="input"
            value={min}
            onChange={(e) => set({ min: e.target.value === '3' ? undefined : e.target.value })}
          >
            {[2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n} entry points
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="m-lib">Library symbols</label>
          <select
            id="m-lib"
            className="input"
            value={library}
            onChange={(e) =>
              set({ library: e.target.value === 'sinks' ? undefined : e.target.value })
            }
          >
            <option value="sinks">Only those called as a sink</option>
            <option value="all">All of them</option>
            <option value="none">None</option>
          </select>
        </div>
      </form>

      {tooMany ? (
        <p className="notice notice-stale">
          A map holds at most 100 entry points: pick a smaller group.
        </p>
      ) : null}
      {map.error ? <ErrorNotice error={map.error} /> : null}

      <div className="split">
        <section
          className="card"
          style={{ flex: '999 1 760px', display: 'flex', flexDirection: 'column' }}
          aria-labelledby="map-title"
        >
          <div className="bar">
            <h2 className="h2" id="map-title">
              {choice?.label}
            </h2>
            <span className="muted" style={{ fontSize: '0.8125rem' }}>
              {data
                ? `${data.entries.length} entry points, ${data.shared.length} shared ${data.shared.length === 1 ? 'callee' : 'callees'}, ${data.shared.reduce((n, s) => n + s.users.length, 0)} calls`
                : ' '}
            </span>
          </div>
          <div style={{ overflow: 'auto' }}>
            {!data ? (
              <div className="empty">
                <Spinner />
              </div>
            ) : data.shared.length === 0 ? (
              <div className="empty">
                <p style={{ margin: 0 }}>
                  No code is called by {min} or more of these entry points. Lower the threshold to
                  see more.
                </p>
              </div>
            ) : (
              <div className="map" style={{ width, height }}>
                <svg
                  width={width}
                  height={height}
                  style={{ position: 'absolute', inset: 0 }}
                  aria-hidden="true"
                >
                  {data.shared.flatMap((s) =>
                    s.users.map((u) => {
                      const a = pos.get(u)
                      const b = pos.get(s.ref)
                      if (!a || !b) return null
                      const lit = picked === s.ref || picked === u
                      return (
                        <line
                          key={`${s.ref}>${u}`}
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          stroke={lit ? 'var(--accent)' : 'var(--border-strong)'}
                          strokeWidth={lit ? 2 : 1}
                          opacity={picked && !lit ? 0.45 : 1}
                        />
                      )
                    }),
                  )}
                </svg>
                {data.entries.map((e) => {
                  const p = pos.get(e.ref) as Placed
                  const right = Math.cos(p.a) >= -0.01
                  const label = e.method && e.path ? `${e.method} ${e.path}` : e.name
                  return (
                    <button
                      key={e.ref}
                      type="button"
                      className="bubble"
                      aria-pressed={picked === e.ref}
                      aria-label={`Entry point ${label}`}
                      onClick={() => setPicked(picked === e.ref ? undefined : e.ref)}
                      style={{
                        left: right ? p.x - 7 : p.x + 7 - 300,
                        top: p.y - 9,
                        width: 300,
                        flexDirection: right ? 'row' : 'row-reverse',
                        opacity: dim(e.ref),
                      }}
                    >
                      <span
                        className="c"
                        style={{
                          width: 14,
                          height: 14,
                          background: 'var(--surface)',
                          border: `2px solid ${picked === e.ref ? 'var(--accent)' : 'var(--text)'}`,
                        }}
                      />
                      <span
                        className="l"
                        style={picked === e.ref ? { fontWeight: 600 } : undefined}
                      >
                        {label}
                      </span>
                    </button>
                  )
                })}
                {data.shared.map((s) => {
                  const p = pos.get(s.ref) as Placed
                  const d = Math.min(64, 14 + s.users.length * 4)
                  const sel = picked === s.ref
                  return (
                    <button
                      key={s.ref}
                      type="button"
                      className="bubble"
                      aria-pressed={sel}
                      aria-label={`${s.name}, called by ${s.users.length} of these entry points${s.sink ? ', as a sink' : ''}`}
                      onClick={() => setPicked(sel ? undefined : s.ref)}
                      style={{
                        left: p.x - 110,
                        top: p.y - d / 2,
                        width: 220,
                        flexDirection: 'column',
                        gap: 2,
                        opacity: dim(s.ref),
                      }}
                    >
                      <span
                        className="c"
                        style={{
                          width: d,
                          height: d,
                          ...(s.sink
                            ? { background: 'var(--sink-bg)', border: '2px solid #b3400e' }
                            : {
                                background: sel ? 'var(--accent)' : '#e3eafb',
                                border: `1px solid ${sel ? 'var(--accent-text)' : 'var(--accent-ring)'}`,
                              }),
                        }}
                      />
                      <span className="l" style={sel ? { fontWeight: 600 } : undefined}>
                        {shortRef(s.ref)} · {s.users.length}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <div className="legend foot">
            <span>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  border: '2px solid var(--text)',
                  display: 'inline-block',
                }}
                aria-hidden="true"
              />
              entry point
            </span>
            <span>
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: '#e3eafb',
                  border: '1px solid var(--accent-ring)',
                  display: 'inline-block',
                }}
                aria-hidden="true"
              />
              shared code, sized by how many entry points call it
            </span>
            <span>
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: 'var(--sink-bg)',
                  border: '2px solid #b3400e',
                  display: 'inline-block',
                }}
                aria-hidden="true"
              />
              library symbol called as a sink
            </span>
            {data?.truncated ? <span>{data.cut.join('; ')}</span> : null}
          </div>
        </section>

        <aside
          className="card pad stack"
          style={{ flex: '1 1 300px', gap: 14 }}
          aria-labelledby="sel-title"
        >
          {selected ? (
            'users' in selected ? (
              <>
                <div className="stack">
                  <span className="h3">
                    {selected.sink
                      ? 'Library sink'
                      : selected.kind === 'external'
                        ? 'Library symbol'
                        : 'Declaration'}
                  </span>
                  <h2 className="h2 mono" id="sel-title" style={{ overflowWrap: 'anywhere' }}>
                    {shortRef(selected.ref)}
                  </h2>
                  <span
                    className="mono muted"
                    style={{ fontSize: '0.75rem', overflowWrap: 'anywhere' }}
                  >
                    {selected.ref}
                  </span>
                </div>
                <section className="stack" style={{ gap: 6 }}>
                  <h3 className="h3">Called by {selected.users.length} of these entry points</h3>
                  <ul className="list stack" style={{ gap: 4 }}>
                    {selected.users.map((u) => {
                      const e = data?.entries.find((x) => x.ref === u)
                      return (
                        <li key={u}>
                          <Link
                            className="link mono"
                            to={entryLink(u)}
                            style={{ fontSize: '0.8125rem' }}
                          >
                            {e?.method && e.path ? `${e.method} ${e.path}` : (e?.name ?? u)}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              </>
            ) : (
              <>
                <div className="stack">
                  <span className="h3">Entry point</span>
                  <h2 className="h2 mono" id="sel-title" style={{ overflowWrap: 'anywhere' }}>
                    {selected.method && selected.path
                      ? `${selected.method} ${selected.path}`
                      : selected.name}
                  </h2>
                </div>
                <section className="stack" style={{ gap: 6 }}>
                  <h3 className="h3">Shared code it calls</h3>
                  <ul className="list stack" style={{ gap: 4 }}>
                    {data?.shared
                      .filter((s) => s.users.includes(selected.ref))
                      .map((s) => (
                        <li key={s.ref}>
                          <button
                            type="button"
                            className="link mono"
                            style={{ fontSize: '0.8125rem' }}
                            onClick={() => setPicked(s.ref)}
                          >
                            {shortRef(s.ref)}
                          </button>
                        </li>
                      ))}
                  </ul>
                </section>
                <Link
                  className="btn"
                  to={entryLink(selected.ref)}
                  style={{ alignSelf: 'flex-start' }}
                >
                  Open as a subgraph
                </Link>
              </>
            )
          ) : (
            <>
              <h2 className="h2" id="sel-title">
                Select a bubble
              </h2>
              <p className="muted" style={{ margin: 0 }}>
                Its links light up, and what it touches is listed here. An entry point opens as a
                subgraph with its code.
              </p>
            </>
          )}
        </aside>
      </div>
    </>
  )
}
