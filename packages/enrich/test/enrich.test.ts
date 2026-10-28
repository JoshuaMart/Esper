import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Claims, Home, insufficient, recordedSource } from '@esper/core'
import { Connection } from '@esper/mcp'
import {
  AnthropicApi,
  ClaudeCode,
  type ClaudeRunner,
  enrich,
  exploringTools,
  scoreGuards,
} from '../src/index.ts'

// Both providers against stand-ins: a `claude` that answers as Claude Code 2.1.312 prints with
// `--output-format json`, and a transport that answers as the Claude API does. No model is
// called and no plan or key is spent.

const run = promisify(execFile)
const fixture = new URL('../../core/test/fixtures/chiapp/', import.meta.url).pathname

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'esper-enrich-'))
  await cp(fixture, dir, { recursive: true })
  await run('git', ['-C', dir, 'init', '--quiet'])
  await run('git', ['-C', dir, 'add', '.'])
  await run('git', [
    '-C',
    dir,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '--quiet',
    '-m',
    'v1',
  ])
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')), {
    advisories: recordedSource(),
  })
  await home.add(dir, { name: 'app' })
  await home.index('app', { ref: 'HEAD', offline: true })
  const connection = new Connection(home, 'app')
  const lines = (await readFile(join(dir, 'mw/mw.go'), 'utf8')).split('\n')
  const auth = lines.findIndex((l) => l.includes('Authorization')) + 1
  const close = async () => {
    connection.close()
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
  return { dir, home, connection, auth, close }
}

// What `claude -p --output-format json` prints for a run that answered.
const printed = (answers: unknown[]) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: JSON.stringify({ answers }),
    structured_output: { answers },
    total_cost_usd: 0.0125,
    usage: {
      input_tokens: 3,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 1000,
      output_tokens: 400,
    },
  })

const answer = (question: string, value: string, extra: Record<string, unknown> = {}) => ({
  question,
  value,
  kind: null,
  text: null,
  citations: [],
  reason: null,
  ...extra,
})

test('claude-code: a bounded run has no tool, no server and none of the auditor’s settings, and starts in Esper’s home', async () => {
  const p = await project()
  try {
    const calls: { args: string[]; input: string; cwd: string }[] = []
    const runner: ClaudeRunner = async (args, input, cwd) => {
      calls.push({ args, input, cwd })
      const auth = { file: 'mw/mw.go', line: p.auth, identifier: 'Authorization' }
      return {
        code: 0,
        stderr: '',
        stdout: printed([
          answer('guard:mw/mw.go#RequireUser', 'yes', { kind: 'authn', citations: [auth] }),
          answer('guard:mw/mw.go#Logger', 'no', {
            citations: [{ file: 'mw/mw.go', line: 1, identifier: 'Logger' }],
          }),
          answer('guard:mw/mw.go#Audit', insufficient),
          // An answer to a question the call did not carry is not taken.
          answer('guard:main.go#health', 'no', { citations: [auth] }),
        ]),
      }
    }
    const folder = join(p.home.dir, 'enrich', 'app')
    const provider = new ClaudeCode({
      folder,
      esper: { command: 'node', args: ['esper'], home: p.home.dir, project: 'app' },
      run: runner,
    })
    const view = p.connection.view()
    const report = await enrich(view, p.connection.store, provider, {
      tier: 'bounded',
      limit: 3,
      kinds: ['guard'],
      only: ['guard:mw/mw.go#RequireUser', 'guard:mw/mw.go#Logger', 'guard:mw/mw.go#Audit'],
    })
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call?.cwd, folder)
    assert.ok(!call?.cwd.startsWith(p.dir))
    const args = call?.args ?? []
    const after = (flag: string) => args[args.indexOf(flag) + 1]
    assert.equal(args[0], '-p')
    assert.ok(args.includes('--safe-mode') && args.includes('--strict-mcp-config'))
    assert.equal(after('--tools'), '')
    assert.equal(after('--model'), 'claude-sonnet-5-5')
    assert.equal(after('--effort'), 'medium')
    assert.equal(after('--max-turns'), '1')
    assert.ok(!args.includes('--mcp-config') && !args.includes('--disallowedTools'))
    // The schema goes inline, as a JSON string, not as a path.
    assert.equal(JSON.parse(after('--json-schema') ?? '').required[0], 'answers')
    assert.match(call?.input ?? '', /## Question guard:mw\/mw.go#RequireUser\n/)
    assert.deepEqual(
      [report.accepted, report.rejected.length, report.insufficient, report.unanswered.length],
      [1, 1, 1, 0],
    )
    // What the run used, as claude reports it.
    assert.deepEqual(report.usage, {
      calls: 1,
      inputTokens: 3,
      outputTokens: 400,
      cacheReadTokens: 1000,
      cacheWriteTokens: 2000,
      costUsd: 0.0125,
    })
    assert.deepEqual(report.rejected, [
      {
        question: 'guard:mw/mw.go#Logger',
        rejection: 'citation mw/mw.go:1: the line does not hold "Logger"',
      },
    ])
    const [claim] = new Claims(p.connection.store).list({ question: 'guard:main.go#health' })
    assert.equal(claim, undefined)
  } finally {
    await p.close()
  }
})

test('claude-code: an exploring run has only Esper’s read-only server, and its claim rests on what it read', async () => {
  const p = await project()
  try {
    let config:
      | {
          mcpServers: Record<
            string,
            { command: string; args: string[]; env: Record<string, string> }
          >
        }
      | undefined
    const runner: ClaudeRunner = async (args) => {
      const after = (flag: string) => args[args.indexOf(flag) + 1] as string
      config = JSON.parse(await readFile(after('--mcp-config'), 'utf8'))
      // Esper's server traces each call: the run reads the handler, then a range of its file.
      const server = config?.mcpServers.esper
      const trace = server?.args[server.args.indexOf('--trace') + 1] as string
      await appendFile(
        trace,
        `${JSON.stringify({ tool: 'esper_node', input: { node: 'routes/users.go#Users.get' } })}\n`,
      )
      await appendFile(
        trace,
        `${JSON.stringify({ tool: 'esper_read', input: { file: 'routes/users.go', startLine: 1 } })}\n`,
      )
      assert.equal(after('--setting-sources'), '')
      assert.ok(!args.includes('--safe-mode'))
      assert.equal(after('--tools'), '')
      assert.equal(after('--allowedTools'), exploringTools.map((t) => `mcp__esper__${t}`).join(','))
      assert.equal(after('--permission-mode'), 'dontAsk')
      assert.equal(after('--max-turns'), '20')
      assert.equal(after('--effort'), 'medium')
      return {
        code: 0,
        stderr: '',
        stdout: printed([
          answer('authentication:repository', 'found', {
            text: 'RequireUser reads the Authorization header in mw/mw.go',
            citations: [{ file: 'mw/mw.go', line: p.auth, identifier: 'Authorization' }],
          }),
        ]),
      }
    }
    const provider = new ClaudeCode({
      folder: join(p.home.dir, 'enrich', 'app'),
      esper: { command: '/usr/bin/node', args: ['/x/main.ts'], home: p.home.dir, project: 'app' },
      run: runner,
    })
    const report = await enrich(p.connection.view(), p.connection.store, provider, {
      tier: 'exploring',
      limit: 1,
      only: ['authentication:repository'],
    })
    assert.deepEqual(config?.mcpServers.esper?.args.slice(0, 4), [
      '/x/main.ts',
      'mcp',
      'app',
      '--read-only',
    ])
    assert.deepEqual(Object.keys(config?.mcpServers ?? {}), ['esper'])
    assert.equal(config?.mcpServers.esper?.env.ESPER_HOME, p.home.dir)
    assert.equal(report.accepted, 1)
    const [claim] = report.claims
    assert.deepEqual(claim?.reads, [
      { tool: 'esper_node', target: 'routes/users.go#Users.get' },
      { tool: 'esper_read', target: 'routes/users.go' },
    ])
    // It rests on every node it read: it holds until one of them changes.
    assert.deepEqual(Object.keys(claim?.fingerprints ?? {}).sort(), [
      'routes/users.go',
      'routes/users.go#Users.get',
    ])
  } finally {
    await p.close()
  }
})

test('claude-code: a run without valid output is retried once; the plan’s limit stops the run', async () => {
  const p = await project()
  try {
    let n = 0
    const flaky: ClaudeRunner = async () => {
      n++
      if (n === 1) return { code: 1, stdout: 'not json', stderr: 'boom' }
      if (n === 2)
        return {
          code: 0,
          stdout: printed([answer('guard:mw/mw.go#Audit', insufficient)]),
          stderr: '',
        }
      if (n <= 4)
        return {
          code: 0,
          stdout: JSON.stringify({ is_error: false, result: 'no schema' }),
          stderr: '',
        }
      return {
        code: 1,
        stderr: '',
        stdout: JSON.stringify({
          is_error: true,
          result: "You've hit your usage limit · resets 5pm",
        }),
      }
    }
    const provider = new ClaudeCode({
      folder: join(p.home.dir, 'enrich', 'app'),
      esper: { command: 'node', args: [], home: p.home.dir, project: 'app' },
      run: flaky,
      parallel: 1,
    })
    const view = p.connection.view()
    const first = await enrich(view, p.connection.store, provider, {
      tier: 'bounded',
      limit: 1,
      only: ['guard:mw/mw.go#Audit'],
    })
    assert.equal(first.insufficient, 1)
    const second = await enrich(view, p.connection.store, provider, {
      tier: 'bounded',
      limit: 1,
      only: ['guard:mw/mw.go#Logger'],
    })
    assert.deepEqual(second.unanswered, [
      { question: 'guard:mw/mw.go#Logger', why: 'claude gave no structured answer' },
    ])
    const third = await enrich(view, p.connection.store, provider, {
      tier: 'bounded',
      limit: 20,
      batch: 2,
    })
    assert.match(third.stopped ?? '', /^the plan's limit is reached: You've hit your usage limit/)
    assert.equal(n, 5)
    assert.ok(third.unanswered.every((u) => u.why === 'not asked: the limit was reached'))
  } finally {
    await p.close()
  }
})

// The Claude API, as far as the provider calls it.
function api(handle: (method: string, path: string, body: unknown) => unknown) {
  const seen: { method: string; path: string; body: unknown }[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    seen.push({ method: init?.method ?? 'GET', path: u.pathname, body })
    const out = handle(init?.method ?? 'GET', u.pathname, body)
    if (typeof out === 'string') {
      return new Response(out, { status: 200, headers: { 'content-type': 'application/x-jsonl' } })
    }
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, seen }
}

const message = (content: unknown[], stop: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
})

test('anthropic-api: bounded questions go through a batch, exploring ones through the tool runner on Esper’s tools', async () => {
  const p = await project()
  try {
    const batch = {
      id: 'msgbatch_1',
      type: 'message_batch',
      processing_status: 'in_progress',
      request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      created_at: '2026-10-28T00:00:00Z',
      expires_at: '2026-10-29T00:00:00Z',
      ended_at: null,
      archived_at: null,
      cancel_initiated_at: null,
      results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_1/results',
    }
    let polls = 0
    let turns = 0
    const auth = { file: 'mw/mw.go', line: p.auth, identifier: 'Authorization' }
    const { fetch, seen } = api((method, path) => {
      if (method === 'POST' && path === '/v1/messages/batches') return batch
      if (method === 'GET' && path === '/v1/messages/batches/msgbatch_1') {
        polls++
        return { ...batch, processing_status: polls < 2 ? 'in_progress' : 'ended' }
      }
      if (path === '/v1/messages/batches/msgbatch_1/results') {
        const text = JSON.stringify({
          answers: [
            answer('guard:mw/mw.go#RequireUser', 'yes', { kind: 'authn', citations: [auth] }),
          ],
        })
        return `${JSON.stringify({
          custom_id: 'call-0',
          result: { type: 'succeeded', message: message([{ type: 'text', text }], 'end_turn') },
        })}\n`
      }
      if (method === 'POST' && path === '/v1/messages') {
        turns++
        if (turns === 1) {
          return message(
            [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'esper_node',
                input: { node: 'mw/mw.go#RequireUser' },
              },
            ],
            'tool_use',
          )
        }
        const text = JSON.stringify({
          answers: [
            answer('authentication:repository', 'found', {
              text: 'a bearer token in the Authorization header',
              citations: [auth],
            }),
          ],
        })
        return message([{ type: 'text', text }], 'end_turn')
      }
      throw new Error(`unexpected ${method} ${path}`)
    })
    const provider = new AnthropicApi({
      connection: p.connection,
      client: { apiKey: 'test-key', fetch, maxRetries: 0 },
      poll: 1,
    })
    const view = p.connection.view()
    const bounded = await enrich(view, p.connection.store, provider, {
      tier: 'bounded',
      limit: 1,
      only: ['guard:mw/mw.go#RequireUser'],
    })
    assert.equal(bounded.accepted, 1)
    const created = seen.find((s) => s.path === '/v1/messages/batches')?.body as {
      requests: { custom_id: string; params: Record<string, unknown> }[]
    }
    const params = created.requests[0]?.params as {
      system: { cache_control: unknown }[]
      output_config: { effort: string; format: { type: string } }
      model: string
    }
    // The instructions every question shares are cached; the answer follows the schema.
    assert.deepEqual(params.system[0]?.cache_control, { type: 'ephemeral' })
    assert.deepEqual(
      [params.output_config.effort, params.output_config.format.type],
      ['medium', 'json_schema'],
    )
    assert.equal(params.model, 'claude-sonnet-5-5')

    const exploring = await enrich(view, p.connection.store, provider, {
      tier: 'exploring',
      limit: 1,
      only: ['authentication:repository'],
    })
    assert.equal(exploring.accepted, 1)
    assert.deepEqual(exploring.claims[0]?.reads, [
      { tool: 'esper_node', target: 'mw/mw.go#RequireUser' },
    ])
    const first = seen.find((s) => s.path === '/v1/messages')?.body as { tools: { name: string }[] }
    assert.deepEqual(first.tools.map((t) => t.name).sort(), [...exploringTools].sort())
    // The tool ran in this process, on the project's connection: its answer went back.
    const second = seen.filter((s) => s.path === '/v1/messages')[1]?.body as {
      messages: { content: { type: string; content?: string }[] }[]
    }
    const result = second.messages.at(-1)?.content.find((b) => b.type === 'tool_result')
    assert.match(String(result?.content ?? JSON.stringify(result)), /RequireUser/)
  } finally {
    await p.close()
  }
})

test('guard claims are scored against answers given by hand, false guards apart', () => {
  const claim = (question: string, value: string, extra: Record<string, unknown> = {}) =>
    ({ question, value, valueKind: null, status: 'accepted', rejection: null, ...extra }) as never
  const score = scoreGuards(
    {
      'guard:a': 'authn',
      'guard:b': 'no',
      'guard:c': 'csrf',
      'guard:d': 'no',
      'guard:e': 'validation',
      'guard:f': 'no',
      'guard:g': 'no',
    },
    [
      claim('guard:a', 'yes', { valueKind: 'authn' }),
      claim('guard:b', 'yes', { valueKind: 'authn' }),
      claim('guard:c', 'yes', { valueKind: 'validation' }),
      claim('guard:d', 'no'),
      claim('guard:e', 'no'),
      claim('guard:f', 'insufficient-context', { status: 'insufficient' }),
      claim('guard:g', 'yes', { status: 'rejected', rejection: 'citation x:1' }),
    ],
  )
  assert.deepEqual(score.outcomes, {
    right: 2,
    'wrong-kind': 1,
    'false-guard': 1,
    'missed-guard': 1,
    insufficient: 1,
    rejected: 1,
    unanswered: 0,
  })
  assert.equal(score.accuracy, 2 / 7)
  assert.equal(score.exploring, 1)
})

test('claude-code: an answer that speaks of a rate limit is an answer, not the plan’s limit', async () => {
  const p = await project()
  try {
    const runner: ClaudeRunner = async () => ({
      code: 0,
      stderr: '',
      stdout: printed([
        answer('guard:mw/mw.go#RequireUser', 'yes', {
          kind: 'rate-limit',
          reason: 'it enforces a rate limit; the usage limit is reached after ten calls',
          citations: [{ file: 'mw/mw.go', line: p.auth, identifier: 'Authorization' }],
        }),
      ]),
    })
    const provider = new ClaudeCode({
      folder: join(p.home.dir, 'enrich', 'app'),
      esper: { command: 'node', args: [], home: p.home.dir, project: 'app' },
      run: runner,
    })
    const report = await enrich(p.connection.view(), p.connection.store, provider, {
      tier: 'bounded',
      limit: 1,
      only: ['guard:mw/mw.go#RequireUser'],
    })
    assert.equal(report.stopped, undefined)
    assert.equal(report.accepted, 1)
  } finally {
    await p.close()
  }
})
