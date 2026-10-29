import {
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import { memo, useEffect, useMemo, useState } from 'react'
import { api, type Claim, type DrawnNode, type NodeDetail, type Subgraph } from './api.ts'
import { useProject } from './app.tsx'
import { Composer, citationsOf } from './composer.tsx'
import {
  formatShortDate,
  href,
  Link,
  navigate,
  shortRef,
  useData,
  useLocation,
  withParams,
} from './lib.tsx'
import {
  AdvisoryStateBadge,
  ErrorNotice,
  Icon,
  KindBadge,
  NoteText,
  SeverityBadge,
  Spinner,
  StateBadge,
} from './ui.tsx'
import { Workspace } from './workspace.tsx'

// An entry point, what it reaches drawn left to right with a layered layout (D14), and the code
// of the node picked in the drawing beside it, with the notes that sit on that node.

const elk = new ELK()

interface CardData extends Record<string, unknown> {
  node?: DrawnNode
  members?: DrawnNode[]
  selected: boolean
  label: string
  kind: 'entry' | 'decl' | 'external' | 'chain' | 'more'
}

const Card = memo(function Card({ data }: NodeProps<Node<CardData>>) {
  const n = data.node
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {data.kind === 'chain' ? (
        <div className="gnode gnode-chain" data-selected={data.selected}>
          <span className="title">Chain · {data.members?.length}</span>
          {data.members?.map((m, i) => (
            <span
              key={m.ref}
              className={i === (data.members?.length ?? 0) - 1 ? 'm last' : 'm'}
              title={m.ref}
            >
              {m.name.replace(/^.*\./, (s) => (m.kind === 'external' ? s : s))}
            </span>
          ))}
        </div>
      ) : (
        <div className={`gnode gnode-${data.kind}`} data-selected={data.selected} title={n?.ref}>
          <span className="name">{data.label}</span>
          {n && (n.sinks > 0 || n.notes > 0 || n.advisories > 0 || n.claims > 0) ? (
            <span className="meta">
              {n.advisories > 0 ? (
                <span className="advisory-count">
                  {n.advisories} {n.advisories === 1 ? 'advisory' : 'advisories'}
                </span>
              ) : null}
              {n.sinks > 0 ? (
                <span className="sink">
                  {n.sinks} {n.sinks === 1 ? 'sink' : 'sinks'}
                </span>
              ) : null}
              {n.notes > 0 ? (
                <span>
                  {n.notes} {n.notes === 1 ? 'note' : 'notes'}
                </span>
              ) : null}
              {n.claims > 0 ? (
                <span className="claim-count">
                  {n.claims} {n.claims === 1 ? 'claim' : 'claims'}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
})

const nodeTypes = { card: Card }

const chainId = '__chain__'
const moreId = '__more__:'

// The drawing: the chain folded into one card unless its members are asked for, then each edge
// between two drawn nodes; a guessed call is dashed.
// How many callees of one node are drawn before the rest fold into a "+ N more" card.
const fanOut = 10

// The callees folded away: past the first `fanOut` of a node, those with a sink or a note first,
// then the target's own code before library symbols; and what is reached only through them.
function folded(graph: Subgraph): { hidden: Set<string>; more: Map<string, number> } {
  const depth = new Map(graph.nodes.map((n) => [n.ref, n.depth]))
  const byRef = new Map(graph.nodes.map((n) => [n.ref, n]))
  const children = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (e.kind !== 'calls' || depth.get(e.to) !== (depth.get(e.from) ?? 0) + 1) continue
    children.set(e.from, [...(children.get(e.from) ?? []), e.to])
  }
  const hidden = new Set<string>()
  const more = new Map<string, number>()
  const rank = (ref: string) => {
    const n = byRef.get(ref)
    return (n && n.sinks + n.notes + n.advisories > 0 ? 0 : 2) + (n?.kind === 'external' ? 1 : 0)
  }
  for (const [parent, kids] of children) {
    const unique = [...new Set(kids)]
    if (unique.length <= fanOut) continue
    const sorted = unique.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
    for (const ref of sorted.slice(fanOut)) hidden.add(ref)
    more.set(parent, unique.length - fanOut)
  }
  // A node every drawn edge into comes from a hidden node is hidden too.
  for (let changed = true; changed; ) {
    changed = false
    for (const n of graph.nodes) {
      if (hidden.has(n.ref) || n.ref === graph.root) continue
      const into = graph.edges.filter((e) => e.to === n.ref && e.from !== n.ref)
      if (into.length > 0 && into.every((e) => hidden.has(e.from))) {
        hidden.add(n.ref)
        changed = true
      }
    }
  }
  return { hidden, more }
}

function build(graph: Subgraph, expand: boolean, selected: string | undefined, full: boolean) {
  const { hidden, more } = full
    ? { hidden: new Set<string>(), more: new Map<string, number>() }
    : folded(graph)
  const members = graph.nodes
    .filter((n) => n.chain !== undefined)
    .sort((a, b) => (a.chain ?? 0) - (b.chain ?? 0))
  const memberSet = new Set(members.map((m) => m.ref))
  const fold = !expand && members.length > 0
  const nodes: { id: string; data: CardData; width: number; height: number }[] = []
  const size = (label: string, meta: boolean) => ({
    width: Math.max(130, Math.min(280, label.length * 7.4 + 28)),
    height: meta ? 50 : 38,
  })
  for (const n of graph.nodes) {
    if (fold && memberSet.has(n.ref)) continue
    if (hidden.has(n.ref)) continue
    const label = n.kind === 'entry' ? n.name : n.kind === 'external' ? n.name : shortRef(n.ref)
    nodes.push({
      id: n.ref,
      data: {
        node: n,
        label,
        kind: n.kind === 'entry' ? 'entry' : n.kind === 'external' ? 'external' : 'decl',
        selected: selected === n.ref,
      },
      ...size(label, n.sinks > 0 || n.notes > 0 || n.advisories > 0 || n.claims > 0),
    })
  }
  if (fold) {
    nodes.push({
      id: chainId,
      data: { members, label: 'Chain', kind: 'chain', selected: false },
      width: 210,
      height: 32 + members.length * 15,
    })
  }
  for (const [parent, count] of more) {
    if (hidden.has(parent)) continue
    const label = `+ ${count} more ${count === 1 ? 'callee' : 'callees'}`
    nodes.push({
      id: `${moreId}${parent}`,
      data: { label, kind: 'more', selected: false },
      width: 170,
      height: 34,
    })
  }
  const edges: Edge[] = []
  const seen = new Set<string>()
  const add = (from: string, to: string, dashed: boolean, title: string) => {
    if (from === to) return
    const id = `${from}>${to}`
    if (seen.has(id)) return
    seen.add(id)
    edges.push({
      id,
      source: from,
      target: to,
      type: 'smoothstep',
      style: {
        stroke: 'var(--edge)',
        strokeWidth: 1.5,
        ...(dashed ? { strokeDasharray: '4 4' } : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#8a8880', width: 14, height: 14 },
      ariaLabel: title,
    })
  }
  const lastMember = members.at(-1)?.ref
  if (members.length > 0) {
    if (fold) add(graph.root, chainId, false, 'chain')
    else {
      add(graph.root, members[0]?.ref as string, false, 'chain')
      for (let i = 1; i < members.length; i++)
        add(members[i - 1]?.ref as string, members[i]?.ref as string, false, 'next in the chain')
    }
  }
  for (const e of graph.edges) {
    if (e.kind === 'chain') continue
    let from = e.from
    let to = e.to
    // The handler runs after the chain: drawn from its last member.
    if (e.kind === 'handles' && members.length > 0) from = fold ? chainId : (lastMember as string)
    if (fold && memberSet.has(from)) from = chainId
    if (fold && memberSet.has(to)) to = chainId
    if (hidden.has(from) || hidden.has(to)) continue
    add(
      from,
      to,
      e.resolution === 'guessed',
      `${e.kind} at ${e.citation}${e.resolution === 'guessed' ? ', guessed' : ''}`,
    )
  }
  for (const parent of more.keys()) {
    if (!hidden.has(parent)) add(parent, `${moreId}${parent}`, false, 'more callees')
  }
  return { nodes, edges }
}

async function place(drawing: ReturnType<typeof build>): Promise<Node<CardData>[]> {
  const laid = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.nodeNode': '14',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: drawing.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: drawing.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  })
  const at = new Map((laid.children ?? []).map((c) => [c.id, c]))
  return drawing.nodes.map((n) => ({
    id: n.id,
    type: 'card',
    position: { x: at.get(n.id)?.x ?? 0, y: at.get(n.id)?.y ?? 0 },
    data: n.data,
    width: n.width,
    height: n.height,
    style: { width: n.width, height: n.height },
    draggable: false,
    connectable: false,
    ariaLabel:
      n.data.kind === 'chain'
        ? `Chain of ${n.data.members?.length} members`
        : `${n.data.kind} ${n.data.node?.ref}`,
  }))
}

function Graph({
  graph,
  expand,
  selected,
  onSelect,
  full,
  onMore,
}: {
  graph: Subgraph
  expand: boolean
  selected: string | undefined
  onSelect: (ref: string) => void
  full: boolean
  onMore: () => void
}) {
  const drawing = useMemo(
    () => build(graph, expand, selected, full),
    [graph, expand, selected, full],
  )
  const [nodes, setNodes] = useState<Node<CardData>[]>([])
  const flow = useReactFlow()
  const shape = `${graph.root}:${graph.nodes.length}:${graph.edges.length}:${expand}:${full}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: laid out again only when the shape changes
  useEffect(() => {
    let current = true
    void place(drawing).then((placed) => {
      if (!current) return
      setNodes(placed)
      requestAnimationFrame(() => void flow.fitView({ padding: 0.08, maxZoom: 1 }))
    })
    return () => {
      current = false
    }
  }, [shape])
  // A new selection only restyles the cards: nothing moves.
  const shown = nodes.map((n) => ({ ...n, data: { ...n.data, selected: n.id === selected } }))
  return (
    <ReactFlow
      nodes={shown}
      edges={drawing.edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      elementsSelectable
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => {
        if (n.id.startsWith(moreId)) onMore()
        else if (n.id === chainId) {
          const last = (n.data as CardData).members?.at(-1)
          if (last) onSelect(last.ref)
        } else onSelect(n.id)
      }}
    />
  )
}

export function EntryPage({ project }: { project: string }) {
  const p = useProject(project)
  const { params } = useLocation()
  const node = params.get('node') ?? ''
  const depth = Number(params.get('depth') ?? 1)
  const expand = params.get('members') === 'true'
  const [all, setAll] = useState(false)
  const set = (changes: Record<string, string | undefined>) =>
    navigate(withParams(changes), { replace: true })

  const graph = useData(
    p.snapshot && node
      ? `${project}:${p.snapshot}:${node}:${depth + 1}:${all}:${p.version}`
      : undefined,
    () =>
      api.subgraph(project, {
        node,
        snapshot: p.snapshot,
        depth: depth + 1,
        limit: all ? 300 : 60,
      }),
  )
  const entry = useData(
    p.snapshot && node ? `${project}:${p.snapshot}:${node}:entry:${p.version}` : undefined,
    () => api.node(project, { node, snapshot: p.snapshot, excerptLines: 40 }),
  )
  const handler = entry.data?.entry?.handlers[0]
  const picked = params.get('at') ?? handler ?? entry.data?.node.ref
  const [composer, setComposer] = useState<{ anchors: string[]; citations: string[] }>()
  const [lines, setLines] = useState<number[]>([])
  // The file of the code shown, for the citations of the lines picked in it.
  const [codeFile, setCodeFile] = useState<string>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lines picked belong to the node shown
  useEffect(() => setLines([]), [picked])

  const e = entry.data?.entry
  const title = e ? (e.method && e.path ? `${e.method} ${e.path}` : e.name) : node
  // The guards a model claims among its chain and handler: shown as claims, never as guards.
  const guardClaims = useData(
    p.snapshot && e ? `${project}:${p.snapshot}:guard-claims:${p.version}` : undefined,
    () => api.claims(project, { snapshot: p.snapshot, kind: 'guard', status: 'accepted' }),
  )
  const claimedGuards = (guardClaims.data?.claims ?? []).filter(
    (c) => c.value === 'yes' && (e?.chain.includes(c.subject) || e?.handlers.includes(c.subject)),
  )
  // The past advisories whose fixed code the entry point reaches (D19).
  const downstream = (entry.data?.facts ?? [])
    .filter((f) => f.kind === 'signal' && f.value === 'fix-downstream')
    .map((f) => ({ advisory: String(f.data?.advisory ?? ''), via: String(f.data?.via ?? '') }))

  return (
    <Workspace
      project={project}
      snapshots={p.snapshots}
      snapshot={p.snapshot}
      latest={p.latest}
      current="entries"
    >
      <main className="page" style={{ gap: 16 }}>
        <nav aria-label="Breadcrumb" className="row" style={{ gap: 6, fontSize: '0.8125rem' }}>
          <Link
            className="link"
            to={href(`/p/${encodeURIComponent(project)}`, { snapshot: p.asked })}
          >
            Entry points
          </Link>
          <span className="muted" aria-hidden="true">
            /
          </span>
          <span className="muted mono">{shortRef(node)}</span>
        </nav>

        {entry.error ? <ErrorNotice error={entry.error} /> : null}

        <section
          className="card stack"
          style={{ padding: '16px 20px', gap: 12 }}
          aria-labelledby="entry-title"
        >
          <div className="head" style={{ alignItems: 'center' }}>
            <div className="row" style={{ gap: 12 }}>
              <h1
                className="h1 mono"
                id="entry-title"
                style={{ fontSize: '1.125rem', overflowWrap: 'anywhere' }}
              >
                {title}
              </h1>
              {e?.file ? (
                <span className="mono muted">
                  {e.file}:{e.line}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="btn"
              disabled={!picked || !p.snapshot}
              onClick={() =>
                picked &&
                setComposer({
                  anchors: [picked],
                  citations: codeFile && lines.length > 0 ? citationsOf(codeFile, lines) : [],
                })
              }
            >
              <Icon name="pen" />
              Write a note
            </button>
          </div>
          {e ? (
            <dl className="facts">
              <div>
                <dt>Handler</dt>
                <dd>
                  {e.handlers.length > 0 ? (
                    e.handlers.map((h) => (
                      <span key={h} className="chip">
                        {shortRef(h)}
                      </span>
                    ))
                  ) : (
                    <span className="muted">none</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Reads</dt>
                <dd>
                  {e.reads.length > 0 ? (
                    e.reads.map((r) => (
                      <span key={r} className="chip">
                        {r}
                      </span>
                    ))
                  ) : (
                    <span className="muted">none</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Signals</dt>
                <dd>
                  {e.signals.length > 0 ? (
                    e.signals.map((s) => (
                      <span key={s} className="chip">
                        {s}
                      </span>
                    ))
                  ) : (
                    <span className="muted">none</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Guards</dt>
                <dd>
                  {e.guards.length > 0 ? (
                    e.guards.map((g) => (
                      <span key={g} className="chip">
                        {g}
                      </span>
                    ))
                  ) : (
                    <span className="muted">none recorded</span>
                  )}
                </dd>
              </div>
              {claimedGuards.length > 0 ? (
                <div>
                  <dt>Guards claimed by a model</dt>
                  <dd>
                    {claimedGuards.map((c) => (
                      <span key={c.id} className="chip chip-claim" title={c.reason ?? ''}>
                        {c.valueKind} · {shortRef(c.subject)}
                      </span>
                    ))}
                  </dd>
                </div>
              ) : null}
              {downstream.length > 0 ? (
                <div>
                  <dt>Past advisories reached</dt>
                  <dd>
                    {downstream.map((f) => (
                      <Link
                        key={`${f.advisory}:${f.via}`}
                        className="chip chip-sink"
                        to={href(`/p/${encodeURIComponent(project)}/advisories`, {
                          id: f.advisory,
                          snapshot: p.asked,
                        })}
                        title={`fixed once in ${f.via}`}
                      >
                        {f.advisory} · {shortRef(f.via)}
                      </Link>
                    ))}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </section>

        <div className="split" style={{ alignItems: 'stretch' }}>
          <section
            className="card"
            style={{ flex: '3 1 640px', display: 'flex', flexDirection: 'column' }}
            aria-labelledby="graph-title"
          >
            <div className="bar">
              <h2 className="h2" id="graph-title">
                What it reaches
              </h2>
              <div className="row" style={{ gap: 16 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted" id="depth-label">
                    Depth
                  </span>
                  <fieldset className="seg" aria-labelledby="depth-label">
                    {[1, 2, 3].map((d) => (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={depth === d}
                        onClick={() => set({ depth: d === 1 ? undefined : String(d) })}
                      >
                        {d}
                      </button>
                    ))}
                  </fieldset>
                </div>
                <label className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={expand}
                    onChange={(ev) => set({ members: ev.target.checked ? 'true' : undefined })}
                  />
                  <span>Chain members</span>
                </label>
              </div>
            </div>
            <div className="flow">
              {graph.error ? (
                <div className="pad">
                  <ErrorNotice error={graph.error} />
                </div>
              ) : graph.data ? (
                <ReactFlowProvider>
                  <Graph
                    graph={graph.data}
                    expand={expand}
                    selected={picked}
                    onSelect={(ref) => set({ at: ref === handler ? undefined : ref })}
                    full={all}
                    onMore={() => setAll(true)}
                  />
                </ReactFlowProvider>
              ) : (
                <div className="empty">
                  <Spinner />
                </div>
              )}
            </div>
            <div className="legend foot">
              <span>
                <svg width="28" height="8" aria-hidden="true">
                  <path d="M0 4 H28" stroke="#8a8880" strokeWidth="2" />
                </svg>
                resolved call
              </span>
              <span>
                <svg width="28" height="8" aria-hidden="true">
                  <path d="M0 4 H28" stroke="#8a8880" strokeWidth="2" strokeDasharray="4 4" />
                </svg>
                guessed call
              </span>
              <span>
                <span
                  style={{
                    display: 'inline-block',
                    width: 16,
                    height: 12,
                    border: '1px solid var(--border-strong)',
                    borderRadius: 3,
                    background: 'var(--bg)',
                  }}
                  aria-hidden="true"
                />
                library symbol
              </span>
              {graph.data ? (
                <span style={{ marginInlineStart: 'auto' }}>
                  {graph.data.total} {graph.data.total === 1 ? 'node' : 'nodes'} reached
                  {graph.data.truncated ? `, ${graph.data.nodes.length - 1} drawn` : ''}
                  {all ? (
                    <>
                      {' · '}
                      <button type="button" className="link" onClick={() => setAll(false)}>
                        fold wide calls
                      </button>
                    </>
                  ) : (
                    <>
                      {' · '}
                      <button type="button" className="link" onClick={() => setAll(true)}>
                        show all
                      </button>
                    </>
                  )}
                </span>
              ) : null}
            </div>
          </section>

          {picked && p.snapshot ? (
            <CodePanel
              project={project}
              snapshot={p.snapshot}
              node={picked}
              version={p.version}
              lines={lines}
              setLines={setLines}
              onWrite={(citations) => setComposer({ anchors: [picked], citations })}
              onFile={setCodeFile}
            />
          ) : null}
        </div>
      </main>
      {composer && p.snapshot ? (
        <Composer
          project={project}
          snapshot={p.snapshot}
          anchors={composer.anchors}
          citations={composer.citations}
          onClose={() => setComposer(undefined)}
          onSaved={() => setLines([])}
        />
      ) : null}
    </Workspace>
  )
}

function CodePanel({
  project,
  snapshot,
  node,
  version,
  lines,
  setLines,
  onWrite,
  onFile,
}: {
  project: string
  snapshot: number
  node: string
  version: number
  lines: number[]
  setLines: (lines: number[]) => void
  onWrite: (citations: string[]) => void
  onFile: (file: string | undefined) => void
}) {
  const detail = useData(`${project}:${snapshot}:${node}:code:${version}`, () =>
    api.node(project, { node, snapshot, excerptLines: 400 }),
  )
  const d = detail.data?.node.ref === node ? detail.data : undefined
  const excerpt = d?.excerpt
  useEffect(() => onFile(excerpt?.file), [excerpt?.file, onFile])
  const [extra, setExtra] = useState<{ start: number; text: string }>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lines read further belong to the node shown
  useEffect(() => setExtra(undefined), [node])

  const marks = useMemo(() => marksOf(d), [d])
  const text = excerpt ? excerpt.text + (extra ? `\n${extra.text}` : '') : ''
  const rows = text ? text.split('\n') : []
  const endLine = excerpt ? excerpt.startLine + rows.length - 1 : 0
  const declaredEnd = d?.node.endLine
  const more = excerpt && declaredEnd !== undefined && endLine < declaredEnd

  const loadMore = async () => {
    if (!excerpt) return
    const read = await api.read(project, {
      file: excerpt.file,
      startLine: endLine + 1,
      endLine: declaredEnd,
      snapshot,
    })
    setExtra({ start: endLine + 1, text: (extra ? `${extra.text}\n` : '') + read.text })
  }

  return (
    <section
      className="card"
      style={{ flex: '2 1 420px', display: 'flex', flexDirection: 'column', minWidth: 0 }}
      aria-labelledby="code-title"
    >
      <div className="bar">
        <h2 className="h2 mono" id="code-title" style={{ overflowWrap: 'anywhere' }}>
          {d ? shortRef(d.node.ref) : shortRef(node)}
        </h2>
        {d?.node.file ? (
          <span className="mono muted">
            {d.node.file}:{d.node.startLine}
            {d.node.endLine && d.node.endLine !== d.node.startLine ? `–${d.node.endLine}` : ''}
          </span>
        ) : null}
      </div>
      {detail.error ? (
        <div className="pad">
          <ErrorNotice error={detail.error} />
        </div>
      ) : !d ? (
        <div className="empty">
          <Spinner />
        </div>
      ) : !excerpt ? (
        <div className="pad stack" style={{ gap: 8 }}>
          <p style={{ margin: 0 }}>
            <span className="mono">{d.node.ref}</span> is{' '}
            {d.node.kind === 'external'
              ? 'a library symbol, outside the target'
              : 'outside the code of this snapshot'}
            : there is no code to show.
          </p>
        </div>
      ) : (
        <>
          <section
            className="code"
            style={{ maxHeight: 440 }}
            aria-label={`Code of ${shortRef(d.node.ref)}`}
          >
            {rows.map((t, i) => {
              const n = excerpt.startLine + i
              const m = marks.get(`${excerpt.file}:${n}`)
              const isPicked = lines.includes(n)
              return (
                <div
                  key={n}
                  className={`ln ${isPicked ? 'ln-picked' : m === 'S' ? 'ln-sink' : m === 'R' ? 'ln-read' : ''}`}
                >
                  <button
                    type="button"
                    className="n"
                    aria-pressed={isPicked}
                    aria-label={`Line ${n}${isPicked ? ', cited' : ''}`}
                    onClick={() =>
                      setLines(isPicked ? lines.filter((x) => x !== n) : [...lines, n])
                    }
                  >
                    {n}
                  </button>
                  <span
                    className={`m ${m === 'S' ? 'mark-sink' : m === 'G' ? 'mark-guard' : 'mark-read'}`}
                    aria-hidden={!m}
                  >
                    {m ?? ''}
                  </span>
                  <pre>{t}</pre>
                </div>
              )
            })}
          </section>
          <div className="row foot" style={{ fontSize: '0.75rem', gap: 16 }}>
            <span className="muted">
              <b className="mark-read">R</b> a read
            </span>
            <span className="muted">
              <b className="mark-sink">S</b> a sink
            </span>
            <span className="muted">
              <b className="mark-guard">G</b> a guard
            </span>
            {lines.length > 0 ? (
              <button
                type="button"
                className="link"
                onClick={() => onWrite(citationsOf(excerpt.file, lines))}
              >
                Write a note citing {lines.length} {lines.length === 1 ? 'line' : 'lines'}
              </button>
            ) : (
              <span className="muted">Click line numbers to cite them</span>
            )}
            {more ? (
              <button
                type="button"
                className="link"
                style={{ marginInlineStart: 'auto' }}
                onClick={() => void loadMore()}
              >
                Read lines {endLine + 1}–{declaredEnd}
              </button>
            ) : null}
          </div>
        </>
      )}
      {d && d.advisories.length > 0 ? <NodeAdvisories project={project} detail={d} /> : null}
      {d && d.claims > 0 ? (
        <NodeClaims project={project} snapshot={snapshot} node={d.node.ref} version={version} />
      ) : null}
      {d ? <NodeNotes project={project} detail={d} /> : null}
    </section>
  )
}

// The line a fact cites, marked in the code: a read, a sink, a guard.
function marksOf(d: NodeDetail | undefined) {
  const marks = new Map<string, 'R' | 'S' | 'G'>()
  for (const f of d?.facts ?? []) {
    const mark =
      f.kind === 'sink' ? 'S' : f.kind === 'read' ? 'R' : f.kind === 'guard' ? 'G' : undefined
    if (mark && marks.get(f.citation) !== 'S') marks.set(f.citation, mark)
  }
  return marks
}

const claimWords: Record<string, (c: Claim) => string> = {
  guard: (c) => (c.value === 'yes' ? `a guard, ${c.valueKind}` : 'not a guard'),
  effects: (c) =>
    c.value === 'sink'
      ? `a sink, ${c.valueKind}`
      : c.value === 'none'
        ? 'no data, no sink'
        : c.value.replaceAll('-', ' '),
  intent: (c) => c.text ?? '',
  trust: (c) => (c.value === 'none' ? 'trusts no request value' : (c.text ?? '')),
  applications: (c) => c.text ?? '',
  authentication: (c) => (c.value === 'none' ? 'no authentication' : (c.text ?? '')),
}

// What a model claimed about this node, apart from its facts (D17): each with the model, the
// lines it cites, checked by code, and whether the code it rests on is still the same.
function NodeClaims({
  project,
  snapshot,
  node,
  version,
}: {
  project: string
  snapshot: number
  node: string
  version: number
}) {
  const claims = useData(`${project}:${snapshot}:${node}:claims:${version}`, () =>
    api.claims(project, { node, snapshot }),
  )
  const shown = (claims.data?.claims ?? []).filter((c) => c.status !== 'rejected')
  return (
    <div
      className="stack claims"
      style={{ padding: 14, borderTop: '1px solid var(--border)', gap: 10 }}
    >
      <h3 className="h2">
        Claimed by a model{' '}
        <span className="muted" style={{ fontWeight: 400 }}>
          {shown.length}
        </span>
      </h3>
      <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
        A model's answers, checked against the lines they cite. They are not facts: they set no
        signal.
      </p>
      {shown.map((c) => (
        <article key={c.id} className="note-card">
          <div className="row" style={{ gap: 8 }}>
            <span className="badge claim-badge">claimed</span>
            <span className="mono" style={{ fontSize: '0.75rem' }}>
              {c.kind}
            </span>
            <span style={{ fontWeight: 500 }}>
              {c.status === 'insufficient'
                ? 'not enough context to answer'
                : claimWords[c.kind]?.(c)}
            </span>
          </div>
          {c.reason ? <p style={{ margin: 0 }}>{c.reason}</p> : null}
          <div className="chips">
            {c.citations.map((x) => (
              <span key={`${x.file}:${x.line}:${x.identifier}`} className="chip">
                {x.file}:{x.line} {x.identifier}
              </span>
            ))}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
            {c.model} through {c.provider}, {c.tier}, {formatShortDate(c.createdAt)}
            {c.author !== `esper enrich (${c.provider})` ? ` · ${c.author}` : ''}
          </p>
        </article>
      ))}
    </div>
  )
}

const codeWords = {
  'as-fixed': 'its code is as the fix left it',
  'as-before-fix': 'its code is as it was before the fix',
  changed: 'its code changed since the fix',
}

// The past advisories whose fix touched this node: where a flaw was once, look for its variants.
function NodeAdvisories({ project, detail }: { project: string; detail: NodeDetail }) {
  return (
    <div className="stack" style={{ padding: 14, borderTop: '1px solid var(--border)', gap: 10 }}>
      <h3 className="h2">
        Past advisories on this node{' '}
        <span className="muted" style={{ fontWeight: 400 }}>
          {detail.advisories.length}
        </span>
      </h3>
      {detail.advisories.map((a) => (
        <article key={a.ref} className="note-card">
          <div className="row" style={{ gap: 8 }}>
            <SeverityBadge severity={a.severity} />
            <AdvisoryStateBadge state={a.state} />
            <span className="mono" style={{ fontSize: '0.75rem' }}>
              {a.name}
            </span>
            <Link
              className="link"
              style={{ marginInlineStart: 'auto', fontSize: '0.75rem' }}
              to={href(`/p/${encodeURIComponent(project)}/advisories`, { id: a.name })}
            >
              Open
            </Link>
          </div>
          <p style={{ margin: 0 }}>{a.summary}</p>
          <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
            Linked by {a.link.precision}
            {a.link.fix ? `, fix ${a.link.fix.slice(0, 12)}` : ''}
            {a.link.code ? `; ${codeWords[a.link.code]}` : ''}
            {a.link.movedFrom ? `; moved from ${shortRef(a.link.movedFrom)}` : ''}.
          </p>
        </article>
      ))}
    </div>
  )
}

function NodeNotes({ project, detail }: { project: string; detail: NodeDetail }) {
  const notes = detail.notes
  return (
    <div className="stack" style={{ padding: 14, borderTop: '1px solid var(--border)', gap: 10 }}>
      <h3 className="h2">
        Notes on this node{' '}
        <span className="muted" style={{ fontWeight: 400 }}>
          {notes.length}
        </span>
      </h3>
      {notes.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          None yet.
        </p>
      ) : null}
      {notes.map((n) => (
        <article key={n.id} className="note-card">
          <div className="row" style={{ gap: 8 }}>
            <KindBadge kind={n.kind} status={n.status} />
            <StateBadge state={n.state} />
            <span className="mono" style={{ fontSize: '0.75rem' }}>
              {n.author}
            </span>
            <span className="muted" style={{ fontSize: '0.75rem' }}>
              {formatShortDate(n.updatedAt)}
            </span>
            <Link
              className="link"
              style={{ marginInlineStart: 'auto', fontSize: '0.75rem' }}
              to={href(`/p/${encodeURIComponent(project)}/notes`, { id: n.id })}
            >
              Open
            </Link>
          </div>
          <NoteText text={n.body} />
          {n.citations.length > 0 ? (
            <div className="chips">
              {n.citations.map((c) => (
                <span key={c} className="chip">
                  {c}
                </span>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  )
}
