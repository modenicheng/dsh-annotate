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
import { join, relative } from 'node:path'

import { SOURCE_PATH, buildArtifacts } from './sync-protocol.mjs'

const root = SOURCE_PATH.replace(/packages[/\\]protocol[/\\]src[/\\]index\.js$/, '')
const normalize = (text) => text.replace(/\r\n/g, '\n')
const label = (path) => relative(root, path).split('\\').join('/')

/**
 * P6: the Web Client's `WIRE` matcher must stay a view of the protocol's
 * mention pattern. The client chips only the canonical `@[label](dsh-anno:id)`
 * form, so its regex is the protocol's markdown alternative without the outer
 * capture — a duplication a comment cannot keep honest. Instead of comparing
 * source text (the two legitimately differ in flags and grouping), both are
 * compiled and run over probes that exercise the label escapes and the id
 * charset; a drift on either side moves a match and fails this check.
 * @param {string} clientLiteral the `/…/` literal from `packages/plugin/client.js`
 * @param {string} protocolLiteral the `/…/` literal from the protocol source
 * @returns {string | null} a problem sentence, or null when they agree
 */
function mentionWireProblem(clientLiteral, protocolLiteral) {
  const toRegExp = (literal) => {
    const body = literal.slice(1, literal.lastIndexOf('/'))
    const flags = literal.slice(literal.lastIndexOf('/') + 1).replace(/[uy]/g, '')
    try {
      return new RegExp(body, flags)
    } catch {
      return null
    }
  }
  const wire = toRegExp(clientLiteral)
  const pattern = toRegExp(protocolLiteral)
  if (wire === null || pattern === null) return 'the mention literals no longer compile'
  // Probes: plain and escaped labels, an id at the edges of the charset, and a
  // malformed id (neither side may match). The bare-URI probe must match the
  // protocol pattern but never the client one (chips are markdown only).
  const markdownProbes = [
    '@[批注 · 那段话](dsh-anno:an-20261118-ab12cd)',
    '@[a\\]b](dsh-anno:id_-Z9)',
    'text @[x](dsh-anno:abc) more',
    '@[label](dsh-anno:short!)',
  ]
  for (const probe of markdownProbes) {
    const wireMatch = wire.exec(probe)?.[0] ?? null
    const patternMatch = pattern.exec(probe)?.[0] ?? null
    // The protocol pattern's first alternative is the markdown form; when that
    // is what matched, its whole match is exactly what the client must chip.
    const expected = patternMatch !== null && patternMatch.startsWith('@[') ? patternMatch : null
    if (wireMatch !== expected) {
      return `on "${probe}" the client WIRE matched ${JSON.stringify(wireMatch)} but the protocol pattern says ${JSON.stringify(expected)}`
    }
  }
  if (wire.test('see dsh-anno:an-20261118-ab12cd')) {
    return 'the client WIRE matches a bare URI, but chips are the markdown form only'
  }
  return null
}

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

  // P6: the client's mention chip matcher against the protocol's parser.
  const CLIENT_PATH = join(root, 'packages', 'plugin', 'client.js')
  const wireLiteral = /const WIRE = (\/.+\/)uy/.exec(normalize(await readFile(CLIENT_PATH, 'utf8')))?.[1]
  const patternLiteral = /const pattern = (\/.+\/)gu/.exec(source)?.[1]
  if (wireLiteral === undefined || patternLiteral === undefined) {
    problems.push('could not find the WIRE / mention-pattern literals (P6 check)')
  } else {
    const problem = mentionWireProblem(wireLiteral, patternLiteral)
    if (problem !== null)
      problems.push(`packages/plugin/client.js WIRE drifted from the protocol mention pattern: ${problem}`)
  }

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
    console.log(
      `check-sync: ok (${artifacts.length} generated artifacts match the protocol source; mention wire pattern in sync)`,
    )
  } else {
    console.error('check-sync: generated protocol files are out of date:')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      '  Fix with: pnpm run sync-protocol (generated copies) or align packages/plugin/client.js WIRE with the mention pattern',
    )
    process.exitCode = 1
  }
}
