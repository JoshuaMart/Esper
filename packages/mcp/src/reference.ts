import { z } from 'zod'
import { type ToolSpec, tools } from './tools.ts'

// The tools' part of the MCP reference page, written from their schemas, so that the page says
// what the server does. `pnpm reference` writes it between the page's markers; a test checks that
// the page is up to date.

export const markers = ['<!-- tools:start -->', '<!-- tools:end -->'] as const

interface Schema {
  type?: string | string[]
  description?: string
  default?: unknown
  enum?: unknown[]
  items?: Schema
  anyOf?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: unknown
  maximum?: number
  minimum?: number
}

function typeOf(schema: Schema): string {
  if (schema.enum) return schema.enum.map((v) => `\`${String(v)}\``).join(', ')
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(' or ')
  if (schema.type === 'array') return `list of ${schema.items ? typeOf(schema.items) : 'any'}`
  if (schema.type === 'object') {
    const keys = Object.keys(schema.properties ?? {})
    return keys.length > 0 ? `object (${keys.map((k) => `\`${k}\``).join(', ')})` : 'object'
  }
  if (schema.type === 'null') return 'null'
  return String(schema.type ?? 'any')
}

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

function table(schema: z.ZodObject, io: 'input' | 'output'): string {
  const json = z.toJSONSchema(schema, { io }) as Schema
  const required = new Set(json.required ?? [])
  const rows = Object.entries(json.properties ?? {}).map(([name, field]) => {
    const notes = [
      field.description ? cell(field.description) : '',
      field.default !== undefined ? `default \`${JSON.stringify(field.default)}\`` : '',
    ].filter(Boolean)
    const optional = io === 'input' ? (required.has(name) ? '' : ' (optional)') : ''
    return `| \`${name}\`${optional} | ${cell(typeOf(field))} | ${notes.join('; ')} |`
  })
  return [
    `| ${io === 'input' ? 'Input' : 'Output'} | Type | |`,
    '|---|---|---|',
    ...(rows.length > 0 ? rows : ['| (none) | | |']),
  ].join('\n')
}

function section(tool: ToolSpec): string {
  return [
    `### \`${tool.name}\``,
    '',
    `${tool.description}${tool.writes ? ' **Writes**: not exposed by a read-only server.' : ''}`,
    '',
    table(tool.input, 'input'),
    '',
    table(tool.output, 'output'),
  ].join('\n')
}

export function toolsReference(): string {
  const summary = [
    '| Tool | Writes | |',
    '|---|---|---|',
    ...tools.map(
      (t) => `| [\`${t.name}\`](#${t.name}) | ${t.writes ? 'yes' : ''} | ${cell(t.title)} |`,
    ),
  ].join('\n')
  return [
    markers[0],
    '',
    summary,
    '',
    ...tools.map(section).flatMap((s) => [s, '']),
    markers[1],
  ].join('\n')
}

// Puts the generated part into a page, between its markers.
export function withTools(page: string): string {
  const start = page.indexOf(markers[0])
  const end = page.indexOf(markers[1])
  if (start < 0 || end < start) throw new Error(`the page has no ${markers.join(' … ')}`)
  return `${page.slice(0, start)}${toolsReference()}${page.slice(end + markers[1].length)}`
}
