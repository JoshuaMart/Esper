// Writes the tools' part of the MCP reference page from their schemas (D13): `pnpm reference`.
import { readFile, writeFile } from 'node:fs/promises'
import { withTools } from '../packages/mcp/src/reference.ts'

const page = new URL('../docs/src/content/docs/reference/mcp.md', import.meta.url)
await writeFile(page, withTools(await readFile(page, 'utf8')))
