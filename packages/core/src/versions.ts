// Versions and scores as advisories state them (D19): a version compared with the ranges of an
// OSV entry, and a CVSS 3 vector's base score, for an entry its database does not rate.

export interface Semver {
  numbers: [number, number, number]
  pre: string[]
}

// A version as `1.2.3`, `v1.2.3`, `1.2` or `1.2.3-rc.1`, build metadata ignored; undefined when it
// is not one.
export function parseVersion(text: string): Semver | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?$/.exec(
    text.trim(),
  )
  if (!match) return undefined
  return {
    numbers: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    pre: match[4] ? match[4].split('.') : [],
  }
}

// Orders two versions as semantic versioning does: a pre-release comes before its release.
export function compareVersions(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    const d = (a.numbers[i] as number) - (b.numbers[i] as number)
    if (d !== 0) return Math.sign(d)
  }
  if (a.pre.length === 0 || b.pre.length === 0) return Math.sign(b.pre.length - a.pre.length)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y))
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export interface RangeEvent {
  introduced?: string
  fixed?: string
  last_affected?: string
  limit?: string
}

export interface Range {
  type: string
  events: RangeEvent[]
}

// Where a version stands against an entry's version ranges: `affected`, `fixed` (a fix came at or
// before it), `unaffected` (before the vulnerable code came in), or undefined when no range is in
// versions it can read. A GIT range is about commits, and is left to the caller.
export function versionState(
  version: Semver,
  ranges: Range[],
): 'affected' | 'fixed' | 'unaffected' | undefined {
  let read = false
  let fixed = false
  for (const range of ranges) {
    if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue
    const events = range.events
      .map((event) => {
        const text = event.introduced ?? event.fixed ?? event.last_affected ?? event.limit ?? ''
        const at = text === '0' ? parseVersion('0.0.0-0') : parseVersion(text)
        return at ? { event, at } : undefined
      })
      .filter((e): e is { event: RangeEvent; at: Semver } => e !== undefined)
      .sort((a, b) => compareVersions(a.at, b.at))
    if (events.length === 0) continue
    read = true
    let state: 'in' | 'out' | 'before' = 'before'
    for (const { event, at } of events) {
      const cmp = compareVersions(version, at)
      if (event.introduced !== undefined && cmp >= 0) state = 'in'
      else if (event.fixed !== undefined && cmp >= 0 && state === 'in') state = 'out'
      else if (event.last_affected !== undefined && cmp > 0 && state === 'in') state = 'out'
    }
    if (state === 'in') return 'affected'
    if (state === 'out') fixed = true
  }
  if (!read) return undefined
  return fixed ? 'fixed' : 'unaffected'
}

const metrics: Record<string, Record<string, number>> = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  C: { H: 0.56, L: 0.22, N: 0 },
  I: { H: 0.56, L: 0.22, N: 0 },
  A: { H: 0.56, L: 0.22, N: 0 },
}

// The base score of a CVSS 3.0 or 3.1 vector, as the specification computes it; undefined for any
// other vector.
export function cvss3Score(vector: string): number | undefined {
  const parts = vector.split('/')
  if (!/^CVSS:3\.[01]$/.test(parts[0] ?? '')) return undefined
  const v = new Map(parts.slice(1).map((p) => p.split(':') as [string, string]))
  const scope = v.get('S')
  if (scope !== 'U' && scope !== 'C') return undefined
  const get = (key: string) => metrics[key]?.[v.get(key) ?? '']
  const pr = { N: 0.85, L: scope === 'C' ? 0.68 : 0.62, H: scope === 'C' ? 0.5 : 0.27 }[
    v.get('PR') ?? ''
  ]
  const [av, ac, ui, c, i, a] = ['AV', 'AC', 'UI', 'C', 'I', 'A'].map(get)
  if ([av, ac, ui, c, i, a, pr].some((x) => x === undefined)) return undefined
  const iss = 1 - (1 - (c as number)) * (1 - (i as number)) * (1 - (a as number))
  const impact = scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
  const exploitability = 8.22 * (av as number) * (ac as number) * (pr as number) * (ui as number)
  if (impact <= 0) return 0
  const raw = scope === 'U' ? impact + exploitability : 1.08 * (impact + exploitability)
  return roundUp(Math.min(raw, 10))
}

// CVSS 3.1's round up to one decimal, which avoids floating-point surprises.
function roundUp(x: number): number {
  const n = Math.round(x * 100_000)
  return n % 10_000 === 0 ? n / 100_000 : (Math.floor(n / 10_000) + 1) / 10
}
