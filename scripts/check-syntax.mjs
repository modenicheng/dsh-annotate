/**
 * Parse every JavaScript source file in the repository with `node --check`.
 *
 * The pre-commit hook and CI both need one cheap gate that catches missing
 * braces, stray tokens, and half-written files before tests run. No build step
 * means no compiler: the runtime itself is the parser.
 */

import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Directories that never contain hand-written source worth checking. */
const SKIP_DIRS = new Set(['.git', '.acl-recovery', '.agents', 'coverage', 'dist', 'node_modules', 'web-ext-artifacts'])
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

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
    if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) files.push(full)
  }
  return files
}

/** @param {string} file */
async function check(file) {
  try {
    await run(process.execPath, ['--check', file], { cwd: root })
    return undefined
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : String(error.message)
    return `${relative(root, file).split('\\').join('/')}\n${stderr}`
  }
}

const files = (await collect(root)).sort()
const failures = (await Promise.all(files.map(check))).filter(Boolean)

if (failures.length === 0) {
  console.log(`check-syntax: ok (${files.length} files)`)
} else {
  console.error(`check-syntax: ${failures.length} file(s) do not parse:`)
  for (const failure of failures) console.error(`\n${failure}`)
  process.exitCode = 1
}
