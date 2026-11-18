/**
 * Fail when a generated protocol copy has drifted from its single source.
 *
 * `scripts/sync-protocol.mjs` writes three artifacts: the plugin's copy, the
 * extension's ESM copy, and an IIFE build for classic content scripts. All are
 * committed so nothing has to resolve a workspace package at runtime, which
 * means CI and the pre-commit hook must prove they are still current. The
 * expected text comes from the same `buildArtifacts` the writer uses, so this
 * check cannot disagree with a fresh regeneration.
 */

import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'

import { SOURCE_PATH, buildArtifacts } from './sync-protocol.mjs'

const root = SOURCE_PATH.replace(/packages[/\\]protocol[/\\]src[/\\]index\.js$/, '')
const normalize = (text) => text.replace(/\r\n/g, '\n')
const label = (path) => relative(root, path).split('\\').join('/')

/** @param {string} expected @param {string} actual */
function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const lineCount = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < lineCount; index += 1) {
    if (expectedLines[index] !== actualLines[index]) return index + 1
  }
  return 1
}

let source
try {
  source = normalize(await readFile(SOURCE_PATH, 'utf8'))
} catch (error) {
  console.error(`check-sync: cannot read ${label(SOURCE_PATH)}: ${error.message}`)
  process.exitCode = 1
}

if (source !== undefined) {
  const artifacts = buildArtifacts(source)
  /** @type {string[]} */
  const problems = []

  for (const artifact of artifacts) {
    const expected = normalize(artifact.text)
    let actual
    try {
      actual = normalize(await readFile(artifact.path, 'utf8'))
    } catch (error) {
      problems.push(
        error.code === 'ENOENT'
          ? `${label(artifact.path)} is missing`
          : `${label(artifact.path)} cannot be read: ${error.message}`,
      )
      continue
    }
    if (actual === expected) continue
    if (actual === source) {
      problems.push(`${label(artifact.path)} is missing the GENERATED banner`)
      continue
    }
    problems.push(
      `${label(artifact.path)} differs from the source (first difference at line ${firstDifference(expected, actual)})`,
    )
  }

  if (problems.length === 0) {
    console.log(`check-sync: ok (${artifacts.length} generated artifacts match the protocol source)`)
  } else {
    console.error('check-sync: generated protocol files are out of date:')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('  Fix with: pnpm run sync-protocol')
    process.exitCode = 1
  }
}
