/**
 * Parse every JavaScript source file in the repository with Node's own parser.
 *
 * The pre-commit hook and CI both need one cheap gate that catches missing
 * braces, stray tokens, and half-written files before tests run. No build step
 * means no compiler: the runtime itself is the parser.
 *
 * One node process parses everything (vm.SourceTextModule is the ESM parser
 * `node --check` uses); spawning a child per file cost ~140 ms of startup each,
 * which made this the slowest check in the hook by an order of magnitude.
 */

import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Directories that never contain hand-written source worth checking. */
const SKIP_DIRS = new Set(['.git', '.acl-recovery', '.agents', 'coverage', 'dist', 'node_modules', 'web-ext-artifacts'])
const EXTENSIONS = new Set(['js', 'mjs', 'cjs'])

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function collect(directory) {
  /** @type {string[]} */
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      files.push(...(await collect(full)))
      continue
    }
    if (entry.isFile() && EXTENSIONS.has(extname(entry.name).slice(1))) files.push(full)
  }
  return files
}

// Runs inside one node process with --experimental-vm-modules (the only way to
// construct SourceTextModule). Reads and parses each file, then prints one
// JSON array of { file, error } for the files that do not parse. `with` and
// bare `return` are Script-only syntax, so .cjs files go through vm.Script.
const PARSER = `
  const { readFileSync } = require('node:fs')
  const vm = require('node:vm')
  const failures = []
  for (const file of process.argv.slice(1)) {
    try {
      const code = readFileSync(file, 'utf8')
      if (file.endsWith('.cjs')) new vm.Script(code, { filename: file })
      else new vm.SourceTextModule(code)
    } catch (error) {
      failures.push({ file, error: String(error && error.message ? error.message : error) })
    }
  }
  process.stdout.write(JSON.stringify(failures))
`

const files = (await collect(root)).sort()
const { stdout } = await run(process.execPath, ['--experimental-vm-modules', '-e', PARSER, '--', ...files], {
  cwd: root,
  maxBuffer: 16 * 1024 * 1024,
})

/** @type {{ file: string, error: string }[]} */
const failures = JSON.parse(stdout)

if (failures.length === 0) {
  console.log(`check-syntax: ok (${files.length} files)`)
} else {
  console.error(`check-syntax: ${failures.length} file(s) do not parse:`)
  for (const failure of failures) console.error(`\n${failure.file}\n${failure.error}`)
  process.exitCode = 1
}
