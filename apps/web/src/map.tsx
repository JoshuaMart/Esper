import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Entry, type SharedMap } from './api.ts'
import { commonPrefix, groupsBy } from './entries.tsx'
import { href, Link, navigate, shortRef, useData, useLocation, withParams } from './lib.tsx'
import { ErrorNotice, Icon, Spinner } from './ui.tsx'

// The map: one group of entry points and the code at least `min` of them call directly, laid out
// by forces: links pull, nodes push apart, and the shared code each settles among the entry points
// that call it. Bounded by the group (D29).

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
  const selected =
    data &&
    (data.shared.find((s) => s.ref === picked) ?? data.entries.find((e) => e.ref === picked))
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
          style={{ flex: '999 1 760px', minWidth: 0, display: 'flex', flexDirection: 'column' }}
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
          <div>
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
              <ForceGraph
                data={data}
                picked={picked}
                onPick={setPicked}
                onOpen={(ref) => navigate(entryLink(ref))}
              />
            )}
          </div>
          <div className="legend foot">
            <span>
              <span
                style={{
                  width: 10,
                  height: 10,
                  background: 'var(--surface)',
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
                  background: 'var(--accent-bg)',
                  border: '1.5px solid var(--accent)',
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

interface Node extends SimulationNodeDatum {
  id: string
  kind: 'entry' | 'shared' | 'sink'
  r: number
  // How many of the group's entry points call it; none for an entry point.
  users: number
  label: string
}

type Edge = SimulationLinkDatum<Node> & { key: string; entry: string; shared: string }

interface View {
  x: number
  y: number
  k: number
}

const height = 640
const clampK = (k: number) => Math.min(3, Math.max(0.25, k))
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// The group as a graph that moves: nodes can be dragged, the view zoomed and panned. Positions are
// written to the drawing on each tick, outside React; React draws the nodes once and their state.
function ForceGraph({
  data,
  picked,
  onPick,
  onOpen,
}: {
  data: SharedMap
  picked: string | undefined
  onPick: (ref: string | undefined) => void
  onOpen: (ref: string) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(900)
  const [view, setView] = useState<View>({ x: 450, y: height / 2, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [hover, setHover] = useState<string>()
  const nodeEls = useRef(new Map<string, SVGGElement>())
  const edgeEls = useRef(new Map<string, SVGLineElement>())
  const touched = useRef(false)
  const drawRef = useRef(() => {})

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [
      ...data.entries.map(
        (e): Node => ({
          id: e.ref,
          kind: 'entry',
          r: 5,
          users: 0,
          label: e.method && e.path ? `${e.method} ${e.path}` : e.name,
        }),
      ),
      ...data.shared.map(
        (s): Node => ({
          id: s.ref,
          kind: s.sink ? 'sink' : 'shared',
          r: Math.min(22, 6 + 1.6 * s.users.length),
          users: s.users.length,
          label: `${shortRef(s.ref)} · ${s.users.length}`,
        }),
      ),
    ]
    const edges: Edge[] = data.shared.flatMap((s) =>
      s.users.map((u) => ({
        key: `${s.ref}>${u}`,
        source: u,
        target: s.ref,
        entry: u,
        shared: s.ref,
      })),
    )
    return { nodes, edges }
  }, [data])

  const simulation = useMemo(
    () =>
      forceSimulation(nodes)
        .force(
          'link',
          forceLink<Node, Edge>(edges)
            .id((d) => d.id)
            .distance((l) => 70 + (l.target as Node).r * 2)
            .strength(0.4),
        )
        .force(
          'charge',
          forceManyBody<Node>().strength((d) => (d.kind === 'entry' ? -140 : -420)),
        )
        .force(
          'collide',
          forceCollide<Node>((d) => d.r + 10),
        )
        .force('x', forceX(0).strength(0.03))
        .force('y', forceY(0).strength(0.045))
        .stop(),
    [nodes, edges],
  )

  // The view that holds every node, with a margin for the labels.
  const fit = () => {
    if (nodes.length === 0) return
    const xs = nodes.map((n) => n.x ?? 0)
    const ys = nodes.map((n) => n.y ?? 0)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const k = clampK(Math.min((width - 240) / (x1 - x0 || 1), (height - 80) / (y1 - y0 || 1), 1.6))
    setView({ k, x: width / 2 - k * ((x0 + x1) / 2), y: height / 2 - k * ((y0 + y1) / 2) })
  }
  const fitRef = useRef(fit)
  fitRef.current = fit

  useEffect(() => {
    const draw = () => {
      for (const n of nodes) {
        nodeEls.current.get(n.id)?.setAttribute('transform', `translate(${n.x},${n.y})`)
      }
      for (const e of edges) {
        const line = edgeEls.current.get(e.key)
        const a = e.source as Node
        const b = e.target as Node
        if (!line) continue
        line.setAttribute('x1', String(a.x))
        line.setAttribute('y1', String(a.y))
        line.setAttribute('x2', String(b.x))
        line.setAttribute('y2', String(b.y))
      }
    }
    drawRef.current = draw
    touched.current = false
    if (reduced()) {
      simulation.tick(300)
      draw()
      fitRef.current()
    } else {
      // Most of the settling happens before the first frame, so that the view fits the layout once
      // and stays put; what is left plays out, and the graph moves again when a node is dragged.
      simulation.alpha(1).tick(150)
      draw()
      fitRef.current()
      simulation.on('tick', draw)
      simulation.alpha(0.3).restart()
    }
    return () => {
      simulation.stop()
      simulation.on('tick', null)
    }
  }, [simulation, nodes, edges])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(320, Math.round(entry.contentRect.width)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A new width fits the graph again, unless the view was moved by hand.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each new width, which is the point
  useEffect(() => {
    if (!touched.current) fitRef.current()
  }, [width])

  // The wheel zooms about the pointer; the page does not scroll under it.
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      touched.current = true
      const box = el.getBoundingClientRect()
      const mx = event.clientX - box.left
      const my = event.clientY - box.top
      const v = viewRef.current
      const k = clampK(v.k * Math.exp(-event.deltaY * 0.0015))
      setView({ k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  const zoom = (factor: number) => {
    touched.current = true
    const v = viewRef.current
    const k = clampK(v.k * factor)
    const [mx, my] = [width / 2, height / 2]
    setView({ k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k })
  }

  // Dragging a node moves it, the others following; dragging the ground pans. A press that does
  // not move is a click.
  const drag = useRef<{
    node?: Node
    x: number
    y: number
    view: View
    moved: boolean
  }>(undefined)
  const toGraph = (clientX: number, clientY: number) => {
    const box = svg.current?.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - (box?.left ?? 0) - v.x) / v.k,
      y: (clientY - (box?.top ?? 0) - v.y) / v.k,
    }
  }
  const down = (event: React.PointerEvent, node?: Node) => {
    if (event.button !== 0) return
    event.stopPropagation()
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, view: viewRef.current, moved: false }
    if (node) drag.current.node = node
  }
  const move = (event: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    touched.current = true
    if (d.node) {
      const p = toGraph(event.clientX, event.clientY)
      d.node.fx = p.x
      d.node.fy = p.y
      if (reduced()) {
        // Under reduced motion the node follows the pointer and nothing else moves.
        d.node.x = p.x
        d.node.y = p.y
        drawRef.current()
      } else {
        simulation.alphaTarget(0.25).restart()
      }
    } else {
      setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy })
    }
  }
  const up = () => {
    const d = drag.current
    drag.current = undefined
    if (!d) return
    if (d.node) {
      d.node.fx = null
      d.node.fy = null
      simulation.alphaTarget(0)
      if (!d.moved) onPick(picked === d.node.id ? undefined : d.node.id)
    } else if (!d.moved) {
      onPick(undefined)
    }
  }

  const focus = hover ?? picked
  const near = new Set<string>()
  if (focus) {
    near.add(focus)
    for (const e of edges) {
      if (e.entry === focus) near.add(e.shared)
      if (e.shared === focus) near.add(e.entry)
    }
  }
  // As in a notes graph, names come with the zoom: the most shared code is always named, the rest
  // when the view is close enough to read it, and whatever is near the node in focus.
  const most = Math.max(1, ...data.shared.map((s) => s.users.length))
  const named = (n: Node) =>
    near.has(n.id) || view.k >= (n.kind === 'entry' ? 1.6 : 1.3) || n.users >= most * 0.6

  return (
    <div ref={wrap} className="fgraph">
      <svg
        ref={svg}
        width={width}
        height={height}
        onPointerDown={(event) => down(event)}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <title>The entry points and the code they share</title>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          <g>
            {edges.map((e) => {
              const lit = focus !== undefined && (e.entry === focus || e.shared === focus)
              return (
                <line
                  key={e.key}
                  ref={(el) => {
                    if (el) edgeEls.current.set(e.key, el)
                    else edgeEls.current.delete(e.key)
                  }}
                  className="fg-edge"
                  data-lit={lit || undefined}
                  data-dim={(focus !== undefined && !lit) || undefined}
                  strokeWidth={(lit ? 2 : 1) / view.k}
                />
              )
            })}
          </g>
          {nodes.map((n) => {
            const sel = picked === n.id
            return (
              // biome-ignore lint/a11y/useSemanticElements: SVG has no button; the group acts as one
              <g
                key={n.id}
                ref={(el) => {
                  if (el) nodeEls.current.set(n.id, el)
                  else nodeEls.current.delete(n.id)
                }}
                className={`fg-node fg-${n.kind}`}
                data-selected={sel || undefined}
                data-dim={(focus !== undefined && !near.has(n.id)) || undefined}
                tabIndex={0}
                role="button"
                aria-pressed={sel}
                aria-label={n.label}
                onPointerDown={(event) => down(event, n)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(undefined)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(undefined)}
                onDoubleClick={() => n.kind === 'entry' && onOpen(n.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && n.kind === 'entry' && sel) onOpen(n.id)
                  else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onPick(sel ? undefined : n.id)
                  }
                }}
              >
                {n.kind === 'entry' ? (
                  <rect x={-n.r} y={-n.r} width={n.r * 2} height={n.r * 2} />
                ) : (
                  <circle r={n.r} />
                )}
                {named(n) ? (
                  <text
                    y={n.kind === 'entry' ? -n.r - 6 : n.r + 14}
                    textAnchor="middle"
                    style={{ fontSize: `${Math.min(12, 11 / Math.min(view.k, 1.4))}px` }}
                  >
                    {n.label}
                  </text>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>
      <div className="fg-tools">
        <button
          type="button"
          className="btn icon-btn"
          aria-label="Zoom in"
          onClick={() => zoom(1.3)}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="btn icon-btn"
          aria-label="Zoom out"
          onClick={() => zoom(1 / 1.3)}
        >
          <Icon name="minus" />
        </button>
        <button type="button" className="btn" onClick={fit}>
          Fit
        </button>
      </div>
      <p className="fg-hint">
        Drag a node to move it · scroll to zoom · drag the ground to pan · double-click an entry
        point to open it
      </p>
    </div>
  )
}
