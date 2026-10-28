import { homedir, userInfo } from 'node:os'
import { EsperError, NotFound } from '@esper/core'
import { type Connection, tools } from '@esper/mcp'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import pkg from '../package.json' with { type: 'json' }
import { mapBounds, shared, subgraph, subgraphBounds } from './graph.ts'
import { HttpError, type Projects, type ServerEvent } from './projects.ts'

// The JSON API the web interface reads and writes (D14). Each route that the MCP surface also
// answers runs the same tool, with the same inputs, bounds and refusals; the drawings of the
// interface (a subgraph, a map) have routes of their own.

type Json = Record<string, unknown>

// Query parameters arrive as text: the ones that are numbers or flags are read as such.
const numbers = new Set([
  'snapshot',
  'limit',
  'offset',
  'depth',
  'excerptLines',
  'startLine',
  'endLine',
  'id',
  'from',
  'to',
  'min',
])
const flags = new Set(['includeDeleted', 'chain', 'force', 'precise', 'offline', 'current'])

function query(params: Record<string, string>): Json {
  const out: Json = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === '') continue
    if (numbers.has(key)) {
      if (!/^-?\d+$/.test(value)) throw new HttpError(400, `${key} is a number, not ${value}`)
      out[key] = Number(value)
    } else if (flags.has(key)) {
      if (value !== 'true' && value !== 'false') {
        throw new HttpError(400, `${key} is true or false, not ${value}`)
      }
      out[key] = value === 'true'
    } else if (key === 'kinds') {
      out[key] = value.split(',')
    } else out[key] = value
  }
  return out
}

// Runs one of the MCP tools for the API: the same validation, bounds and answer.
async function call(
  connection: Connection,
  name: string,
  input: Json,
  progress?: (message: string) => void,
): Promise<Json> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  const parsed = tool.input.safeParse(input)
  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues
        .map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`)
        .join('; '),
    )
  }
  return (await tool.run(connection, parsed.data as never, progress)) as Json
}

// A body is JSON, said so: a form or a text/plain body, which a page elsewhere can send without
// asking the browser first, is refused.
async function body(c: {
  req: { json: () => Promise<unknown>; header: (name: string) => string | undefined }
}): Promise<Json> {
  const type = c.req.header('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(415, 'the body is JSON, sent as application/json')
  }
  const value = await c.req.json().catch(() => {
    throw new HttpError(400, 'the body is not JSON')
  })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'the body is a JSON object')
  }
  return value as Json
}

const integer = (value: unknown, what: string, bound: { min: number; max: number }) => {
  if (value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < bound.min ||
    value > bound.max
  ) {
    throw new HttpError(400, `${what} is a whole number from ${bound.min} to ${bound.max}`)
  }
  return value
}

export interface Job {
  id: number
  project: string
  // An index, or a fetch of the advisories again.
  action: 'index' | 'advisories'
  state: 'running' | 'done' | 'failed'
  startedAt: string
  messages: string[]
  input: Json
  result?: unknown
  error?: string
}

// How many finished jobs are remembered.
const keptJobs = 20

export function api(projects: Projects) {
  const app = new Hono()
  const jobs: Job[] = []
  let nextJob = 1

  const project = (name: string) => projects.connection(name)
  // Right after this server writes, listeners hear of it without waiting for the timer.
  const wrote = <T>(value: T) => {
    projects.check()
    return value
  }

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status)
    if (error instanceof EsperError) {
      return c.json({ error: error.message }, error instanceof NotFound ? 404 : 400)
    }
    console.error(error)
    return c.json({ error: 'the server failed; its log says why' }, 500)
  })

  app.get('/info', (c) =>
    c.json({ name: pkg.name, version: pkg.version, user: userInfo().username }),
  )

  app.get('/projects', async (c) => {
    const list = []
    for (const p of await projects.home.projects()) {
      const connection = await project(p.name)
      const answer = await call(connection, 'esper_snapshots', { limit: 200 })
      const snapshots = answer.snapshots as Json[]
      const latest = snapshots.find((s) => s.id === answer.latest)
      const profiles = (latest?.profiles as string[] | undefined) ?? []
      list.push({
        name: p.name,
        source: p.source,
        // The source as a person reads it: a folder in the home directory starts with ~.
        shown:
          'path' in p.source
            ? p.source.path.startsWith(`${homedir()}/`)
              ? `~${p.source.path.slice(homedir().length)}`
              : p.source.path
            : p.source.url,
        kind:
          p.kind ??
          (profiles.some((s) => s.endsWith('/framework'))
            ? 'framework'
            : profiles.length > 0
              ? 'application'
              : null),
        kindForced: p.kind !== undefined,
        snapshots: snapshots.length,
        latest: latest ?? null,
      })
    }
    return c.json({ projects: list })
  })

  app.post('/projects', async (c) => {
    const input = await body(c)
    if (typeof input.source !== 'string' || input.source.trim() === '') {
      throw new HttpError(400, 'source is a folder or a git URL')
    }
    if (input.name !== undefined && typeof input.name !== 'string') {
      throw new HttpError(400, 'name is text')
    }
    if (input.kind !== undefined && input.kind !== 'application' && input.kind !== 'framework') {
      throw new HttpError(400, 'kind is application or framework')
    }
    const added = await projects.home.add(input.source.trim(), {
      ...(input.name ? { name: input.name } : {}),
      ...(input.kind ? { kind: input.kind as 'application' | 'framework' } : {}),
    })
    return c.json({ project: added }, 201)
  })

  app.get('/projects/:project/snapshots', async (c) =>
    c.json(
      await call(await project(c.req.param('project')), 'esper_snapshots', {
        limit: 200,
        ...query(c.req.query()),
      }),
    ),
  )

  app.get('/projects/:project/diff', async (c) =>
    c.json(await call(await project(c.req.param('project')), 'esper_diff', query(c.req.query()))),
  )

  // An index, or a fetch of the advisories, runs as a job: the answer comes at once, and the
  // job's progress and result come as events, and from GET /jobs. One runs at a time per project.
  const start = (
    name: string,
    action: Job['action'],
    input: Json,
    work: (tell: (message: string) => void) => Promise<unknown>,
  ): Job => {
    if (jobs.some((j) => j.project === name && j.state === 'running')) {
      throw new HttpError(409, `${name} is already being indexed or its advisories fetched`)
    }
    const job: Job = {
      id: nextJob++,
      project: name,
      action,
      state: 'running',
      startedAt: new Date().toISOString(),
      messages: [],
      input,
    }
    jobs.push(job)
    while (jobs.length > keptJobs && jobs[0]?.state !== 'running') jobs.shift()
    const tell = (event: Partial<Extract<ServerEvent, { type: 'job' }>>) =>
      projects.emit({ type: 'job', project: name, id: job.id, action, state: job.state, ...event })
    tell({})
    // Let the answer go out before the work, which holds the event loop while it parses.
    setImmediate(() => {
      work((message) => {
        job.messages.push(message)
        tell({ message })
      }).then(
        (result) => {
          job.state = 'done'
          job.result = result
          tell({ result })
          projects.check()
        },
        (error: unknown) => {
          job.state = 'failed'
          job.error =
            error instanceof EsperError
              ? error.message
              : `the ${action} failed; the server log says why`
          if (!(error instanceof EsperError)) console.error(error)
          tell({ error: job.error })
        },
      )
    })
    return job
  }

  app.post('/projects/:project/index', async (c) => {
    const name = c.req.param('project')
    const connection = await project(name)
    const input = await body(c)
    // The input is checked before the job starts, so that a mistake is refused at once.
    const tool = tools.find((t) => t.name === 'esper_index')
    const parsed = tool?.input.safeParse(input)
    if (!parsed?.success) {
      throw new HttpError(400, parsed?.error.issues.map((i) => i.message).join('; ') ?? 'invalid')
    }
    const job = start(name, 'index', input, (tell) => call(connection, 'esper_index', input, tell))
    return c.json({ job }, 202)
  })

  app.get('/projects/:project/advisories', async (c) =>
    c.json(
      await call(await project(c.req.param('project')), 'esper_advisories', {
        limit: 200,
        ...query(c.req.query()),
      }),
    ),
  )

  // Fetches the advisories from OSV again and links them, as `esper advisories` does.
  app.post('/projects/:project/advisories', async (c) => {
    const name = c.req.param('project')
    await project(name)
    const input = await body(c)
    if (Object.keys(input).length > 0) throw new HttpError(400, 'the body is {}')
    const job = start(name, 'advisories', input, async (tell) => {
      tell('fetching the advisories from OSV and linking them')
      return projects.home.advisories(name)
    })
    return c.json({ job }, 202)
  })

  app.get('/jobs', (c) => c.json({ jobs }))

  app.get('/projects/:project/entrypoints', async (c) =>
    c.json(
      await call(await project(c.req.param('project')), 'esper_entrypoints', {
        limit: 500,
        ...query(c.req.query()),
      }),
    ),
  )

  app.get('/projects/:project/node', async (c) =>
    c.json(await call(await project(c.req.param('project')), 'esper_node', query(c.req.query()))),
  )

  app.get('/projects/:project/read', async (c) =>
    c.json(await call(await project(c.req.param('project')), 'esper_read', query(c.req.query()))),
  )

  app.get('/projects/:project/search', async (c) =>
    c.json(await call(await project(c.req.param('project')), 'esper_search', query(c.req.query()))),
  )

  app.get('/projects/:project/paths', async (c) => {
    const q = query(c.req.query())
    const { fact, value, ...rest } = q
    return c.json(
      await call(await project(c.req.param('project')), 'esper_paths', {
        ...rest,
        ...(typeof fact === 'string'
          ? { toFact: { kind: fact, ...(value ? { value } : {}) } }
          : {}),
      }),
    )
  })

  // What a node reaches, drawn: its nodes and every edge between them.
  app.get('/projects/:project/subgraph', async (c) => {
    const connection = await project(c.req.param('project'))
    const q = query(c.req.query())
    if (typeof q.node !== 'string') throw new HttpError(400, 'node names the node to start from')
    const view = connection.view(q.snapshot as number | undefined)
    const root = view.resolve(q.node)
    const depth =
      integer(q.depth, 'depth', { min: 1, max: subgraphBounds.maxDepth }) ?? subgraphBounds.depth
    const limit =
      integer(q.limit, 'limit', { min: 1, max: subgraphBounds.max }) ?? subgraphBounds.limit
    const notes = new Map<string, number>()
    for (const p of connection.placed(view.info.id)) {
      for (const node of new Set(p.anchors.map((a) => a.node))) {
        if (node) notes.set(node, (notes.get(node) ?? 0) + 1)
      }
    }
    // The claims that hold on this snapshot, by node.
    const claims = new Map<string, number>()
    for (const c of connection.claims.list()) {
      if (c.status !== 'rejected' && connection.claims.current(c, view)) {
        claims.set(c.subject, (claims.get(c.subject) ?? 0) + 1)
      }
    }
    const drawn = subgraph(view, root, { depth, limit, chain: q.chain === true, notes, claims })
    const cut =
      drawn.nodes.length - 1 < drawn.total
        ? [
            `nodes: ${drawn.nodes.length - 1} of ${drawn.total} drawn; raise limit (at most ${subgraphBounds.max}) or lower depth`,
          ]
        : []
    return c.json({
      snapshot: { id: view.info.id, ref: view.info.ref, commit: view.info.commit },
      root: root.ref,
      depth,
      ...drawn,
      truncated: cut.length > 0,
      cut,
    })
  })

  // The code a group of entry points shares, for the map.
  app.post('/projects/:project/map', async (c) => {
    const connection = await project(c.req.param('project'))
    const input = await body(c)
    const refs = input.entries
    if (!Array.isArray(refs) || refs.length === 0 || refs.some((r) => typeof r !== 'string')) {
      throw new HttpError(400, 'entries lists the entry points of the group, by reference')
    }
    if (refs.length > mapBounds.entries) {
      throw new HttpError(400, `a map holds at most ${mapBounds.entries} entry points`)
    }
    const library = input.library ?? 'sinks'
    if (library !== 'all' && library !== 'sinks' && library !== 'none') {
      throw new HttpError(400, 'library is all, sinks or none')
    }
    const view = connection.view(
      integer(input.snapshot, 'snapshot', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    )
    const entries = (refs as string[]).map((r) => {
      const node = view.resolve(r)
      if (node.kind !== 'entry') throw new HttpError(400, `${r} is not an entry point`)
      return node
    })
    const min = integer(input.min, 'min', { min: 1, max: mapBounds.entries }) ?? mapBounds.min
    const map = shared(view, entries, { min, library, limit: mapBounds.shared })
    const cut =
      map.shared.length < map.total
        ? [`shared: ${map.shared.length} of ${map.total} drawn; raise min to see the most shared`]
        : []
    return c.json({
      snapshot: { id: view.info.id, ref: view.info.ref, commit: view.info.commit },
      ...map,
      truncated: cut.length > 0,
      cut,
    })
  })

  app.get('/projects/:project/claims', async (c) =>
    c.json(
      await call(await project(c.req.param('project')), 'esper_claims', {
        limit: 500,
        ...query(c.req.query()),
      }),
    ),
  )

  app.get('/projects/:project/notes', async (c) =>
    c.json(
      await call(await project(c.req.param('project')), 'esper_notes', {
        limit: 100,
        ...query(c.req.query()),
      }),
    ),
  )

  app.post('/projects/:project/notes', async (c) => {
    const connection = await project(c.req.param('project'))
    return c.json(wrote(await call(connection, 'esper_note_create', await body(c))), 201)
  })

  app.patch('/projects/:project/notes/:id', async (c) => {
    const connection = await project(c.req.param('project'))
    const id = Number(c.req.param('id'))
    return c.json(wrote(await call(connection, 'esper_note_update', { ...(await body(c)), id })))
  })

  app.delete('/projects/:project/notes/:id', async (c) => {
    const connection = await project(c.req.param('project'))
    const id = Number(c.req.param('id'))
    return c.json(wrote(await call(connection, 'esper_note_delete', { ...(await body(c)), id })))
  })

  // What changes, as it changes: notes written here or by an agent, new snapshots, index jobs.
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0
      const queue: ServerEvent[] = []
      let wake: (() => void) | undefined
      const stop = projects.listen((event) => {
        queue.push(event)
        wake?.()
      })
      stream.onAbort(() => {
        stop()
        wake?.()
      })
      await stream.writeSSE({ event: 'ready', data: '{}' })
      while (!stream.aborted) {
        const event = queue.shift()
        if (event) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
            id: String(++id),
          })
          continue
        }
        // A comment now and then keeps proxies and the browser from closing a quiet stream.
        let quiet = false
        let timer: NodeJS.Timeout | undefined
        await new Promise<void>((resolve) => {
          wake = resolve
          timer = setTimeout(() => {
            quiet = true
            resolve()
          }, 15_000)
          timer.unref()
        })
        clearTimeout(timer)
        wake = undefined
        if (quiet && !stream.aborted) await stream.write(': keep-alive\n\n')
      }
      stop()
    }),
  )

  return app
}
