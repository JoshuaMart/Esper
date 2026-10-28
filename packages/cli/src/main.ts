#!/usr/bin/env node
import { parseArgs } from 'node:util'
import pkg from '../package.json' with { type: 'json' }

const usage = `Usage: esper <command> [options]

Options:
  --version  print the version
  --help     print this help

Commands are added from M1 on: add, index, list.`

// Unknown options are refused, not ignored: a mistyped `--read-only` must not start a server
// that writes.
function parse() {
  try {
    return parseArgs({
      options: {
        version: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      allowPositionals: true,
    })
  } catch (error) {
    console.error(`esper: ${(error as Error).message}\n\n${usage}`)
    process.exit(2)
  }
}

const { values, positionals } = parse()
if (values.version) {
  console.log(`${pkg.name} ${pkg.version}`)
} else if (values.help || positionals.length === 0) {
  console.log(usage)
} else {
  console.error(`esper: unknown command '${positionals[0]}'\n\n${usage}`)
  process.exitCode = 2
}
