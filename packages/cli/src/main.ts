#!/usr/bin/env node
import { parseArgs } from 'node:util'
import pkg from '../package.json' with { type: 'json' }

const usage = `Usage: esper <command> [options]

Options:
  --version  print the version
  --help     print this help

Commands are added from M1 on: add, index, list.`

const { values, positionals } = parseArgs({
  options: {
    version: { type: 'boolean' },
    help: { type: 'boolean' },
  },
  allowPositionals: true,
  strict: false,
})

if (values.version) {
  console.log(`${pkg.name} ${pkg.version}`)
} else if (values.help || positionals.length === 0) {
  console.log(usage)
} else {
  console.error(`esper: unknown command '${positionals[0]}'\n\n${usage}`)
  process.exitCode = 2
}
