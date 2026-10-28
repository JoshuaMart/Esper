import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import type { Home } from '@esper/core'
import { createServer } from '@esper/mcp'
import { serve as listen } from '@hono/node-server'
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { api } from './api.ts'
import { Projects } from './projects.ts'

// `esper serve` (D14, D18): one process on localhost for the JSON API, MCP over Streamable HTTP
// at /mcp/<project>, and the web interface's files. Every request to the API or to MCP carries
// the token, as a bearer token or as the cookie the interface is given; a request whose Host or
// Origin is not this machine is refused, so that a web page elsewhere cannot reach the server
// through DNS rebinding.

export const defaultPort = 7300
export const cookieName = 'esper_session'
export const webDir = new URL('../../../apps/web/dist/', import.meta.url).pathname

const local = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function hostname(value: string): string | undefined {
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return undefined
  }
}

// The server's token, kept in Esper's home so that agents keep theirs across restarts.
export async function serverToken(home: Home): Promise<string> {
  const path = join(home.dir, 'token')
  const kept = await readFile(path, 'utf8').catch(() => undefined)
  if (kept && /^[A-Za-z0-9_-]{32,}$/.test(kept.trim())) return kept.trim()
  const token = randomBytes(32).toString('base64url')
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  return token
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

export interface AppOptions {
  token: string
  // Where the built interface is; none serves only the API and MCP.
  web?: string
}

export function createApp(home: Home, options: AppOptions) {
  const projects = new Projects(home)
  const expected = Buffer.from(options.token)
  const valid = (token: string | undefined) => {
    if (!token) return false
    const given = Buffer.from(token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
  const bearer = (header: string | undefined) => header?.match(/^Bearer\s+(\S+)$/i)?.[1]

  const app = new Hono()

  app.use(async (c, next) => {
    const host = hostname(c.req.header('host') ?? '')
    if (!host || !local.has(host)) {
      return c.json({ error: 'this server answers requests to localhost only' }, 403)
    }
    // A page of this server is its own origin, port included: a page another local server serves
    // is the same site for the browser, and would send the cookie.
    const origin = c.req.header('origin')
    if (origin !== undefined && origin !== `http://${c.req.header('host')}`) {
      return c.json({ error: 'requests from another site are refused' }, 403)
    }
    await next()
  })

  // The API and MCP need the token: in the Authorization header, or in the session cookie.
  app.use('/api/*', async (c, next) => {
    if (!valid(bearer(c.req.header('authorization')) ?? getCookie(c, cookieName))) {
      return c.json({ error: 'open the address esper serve printed: it carries the token' }, 401)
    }
    await next()
  })
  app.use('/mcp/*', async (c, next) => {
    if (!valid(bearer(c.req.header('authorization')))) {
      return c.json(
        { error: 'send the token esper serve printed, as Authorization: Bearer <token>' },
        401,
      )
    }
    await next()
  })

  // The interface trades the token in its address for a cookie that pages elsewhere cannot send.
  app.post('/api/session', (c) => {
    setCookie(c, cookieName, options.token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    })
    return c.json({ ok: true })
  })

  app.route('/api', api(projects))

  // One MCP handler per project, each serving the tools of M2 on the project's shared connection.
  const handlers = new Map<string, McpHttpHandler>()
  app.all('/mcp/:project', async (c) => {
    const name = c.req.param('project')
    let handler = handlers.get(name)
    if (!handler) {
      const connection = await projects.connection(name).catch(() => undefined)
      if (!connection) return c.json({ error: `no project named ${name}` }, 404)
      handler = createMcpHandler(() => createServer(connection), {
        onerror: (error) => console.error(error),
      })
      handlers.set(name, handler)
    }
    const response = await handler.fetch(c.req.raw)
    projects.check()
    return response
  })

  app.all('/api/*', (c) => c.json({ error: `no route ${c.req.method} ${c.req.path}` }, 404))

  // The interface: its files, and its index.html for every other path, where it routes itself.
  const web = options.web
  app.get('*', async (c) => {
    if (!web) return c.text('this server was started without the web interface', 404)
    const root = resolve(web)
    let path: string
    try {
      path = decodeURIComponent(c.req.path)
    } catch {
      path = '/'
    }
    const wanted = resolve(root, `.${path}`)
    let file = wanted.startsWith(root + sep) ? wanted : join(root, 'index.html')
    if (!(await stat(file).catch(() => undefined))?.isFile()) file = join(root, 'index.html')
    const content = await readFile(file).catch(() => undefined)
    if (!content) {
      return c.text('the web interface is not built: run pnpm --filter @esper/web build', 404)
    }
    const immutable = file.includes(`${sep}assets${sep}`)
    return c.body(content, 200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      ...(extname(file) === '.html'
        ? {
            'content-security-policy':
              "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          }
        : {}),
    })
  })

  const close = async () => {
    for (const handler of handlers.values()) await handler.close()
    projects.close()
  }
  return { app, projects, close }
}

// Starts the server on localhost, and resolves once it listens.
export async function serve(
  home: Home,
  options: { port?: number; token?: string; web?: string } = {},
) {
  const token = options.token ?? (await serverToken(home))
  const web =
    options.web ??
    ((await stat(join(webDir, 'index.html')).catch(() => undefined)) ? webDir : undefined)
  const { app, close } = createApp(home, { token, ...(web ? { web } : {}) })
  const server = await new Promise<Server>((done, fail) => {
    // Without options for HTTP/2 or TLS, the server is a node:http one.
    const s = listen(
      { fetch: app.fetch, port: options.port ?? defaultPort, hostname: '127.0.0.1' },
      () => done(s as Server),
    )
    s.once('error', fail)
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    web: web !== undefined,
    close: async () => {
      await close()
      // An open event stream would hold the server open.
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
