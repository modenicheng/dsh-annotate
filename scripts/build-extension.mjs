/**
 * Build the two unpacked extension targets from the single source tree.
 *
 * `packages/extension` is what a developer loads in `about:debugging`; the two
 * stores want one artifact each, and the difference is the manifest. Gecko gets
 * the tree as written. Chromium needs a manifest it actually accepts:
 *
 *   - `background.scripts` is rejected; MV3 there runs one
 *     `background.service_worker`, so it points at `src/background/sw.js`,
 *     which imports the same files in the same order.
 *   - `browser_specific_settings` is a Gecko key.
 *   - match patterns accept only `http`, `https`, `*`, and `file`, so the
 *     `ws://`/`wss://` host permissions are invalid. The `http`/`https` loopback
 *     entries stay: they are what the discovery probe and the session catalogue
 *     fetch need.
 *   - content scripts must load `src/shared/platform.js` first (see
 *     `transformManifest`).
 *
 * Everything else is copied verbatim — no bundler, no transpiler. The one thing
 * that cannot be copied verbatim is the service worker's `importScripts` list,
 * which is a literal inside a classic script; this script compares it with the
 * manifest and refuses to build when the two disagree (D1: generated, checked in
 * CI, not a build system).
 *
 * Run: node scripts/build-extension.mjs [--target firefox|chromium]
 */

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDir = join(root, 'packages', 'extension')
const distDir = join(root, 'dist')

/** Targets this script knows how to produce. */
export const TARGETS = ['firefox', 'chromium']
/** The engine shim every context must load first. */
export const PLATFORM_SCRIPT = 'src/shared/platform.js'
/** The Chromium entry point that imports the background files. */
export const SERVICE_WORKER = 'src/background/sw.js'
/** What `browser_specific_settings` is called in the source manifest. */
const GECKO_KEY = 'browser_specific_settings'

/**
 * Files a user must not receive even though they sit in the source tree.
 * `web-ext build` would otherwise pack the development manifest, the tests, and
 * a previous build into the artifact.
 */
const SKIPPED_NAMES = new Set(['package.json', 'amo-metadata.json', '.DS_Store', 'test', 'dist'])
const SKIPPED_DIRECTORIES = new Set(['test', 'dist'])

/**
 * Is this path part of the packaged extension?
 * @param {string[]} segments path segments below the extension root
 * @returns {boolean}
 */
function isPackaged(segments) {
  const name = segments[segments.length - 1] ?? ''
  if (SKIPPED_NAMES.has(name) || name.endsWith('.log')) return false
  return !segments.slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment))
}

/**
 * Copy the source tree into `destination`, skipping what must not ship.
 * @param {string} from the directory being copied
 * @param {string} to the directory its contents go into
 * @param {string[]} [prefix] the source-relative path of `from`, for reporting
 * @returns {Promise<string[]>} the relative paths written, `/`-separated
 */
async function copyTree(from, to, prefix = []) {
  /** @type {string[]} */
  const written = []
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const segments = [...prefix, entry.name]
    if (!isPackaged(segments)) continue
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true })
      written.push(...(await copyTree(source, destination, segments)))
      continue
    }
    if (!entry.isFile()) continue
    await copyFile(source, destination)
    written.push(segments.join('/'))
  }
  return written
}

/**
 * The background file order a Chromium service worker must import: the shim
 * first, then the manifest's list. A manifest that already starts with the shim
 * is taken as written, so adding it there later does not require a second copy.
 * @param {unknown} backgroundScripts
 * @returns {string[]}
 */
export function expectedServiceWorkerScripts(backgroundScripts) {
  const listed = Array.isArray(backgroundScripts)
    ? backgroundScripts.filter((path) => typeof path === 'string' && path !== '')
    : []
  return listed[0] === PLATFORM_SCRIPT ? [...listed] : [PLATFORM_SCRIPT, ...listed]
}

/**
 * Read the `BACKGROUND_SCRIPTS` array out of `sw.js` without executing it.
 * @param {string} source
 * @returns {string[]}
 */
export function parseServiceWorkerScripts(source) {
  const match = /const BACKGROUND_SCRIPTS = \[([\s\S]*?)\]/.exec(source)
  if (match === null) throw new Error('sw.js has no `const BACKGROUND_SCRIPTS = [...]` declaration')
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

/**
 * Compare the service worker's literal list with the manifest's background
 * order. Returns `{ actual, expected, problems }`; an empty `problems` array is
 * the only acceptable result, and both the build and the test suite use it.
 * @param {string} swSource
 * @param {unknown} backgroundScripts `manifest.background.scripts`
 * @returns {{ actual: string[], expected: string[], problems: string[] }}
 */
export function compareServiceWorkerScripts(swSource, backgroundScripts) {
  const actual = parseServiceWorkerScripts(swSource)
  const expected = expectedServiceWorkerScripts(backgroundScripts)
  /** @type {string[]} */
  const problems = []
  if (actual.length !== expected.length) {
    problems.push(`sw.js imports ${actual.length} script(s), the manifest implies ${expected.length}`)
  } else {
    for (const [index, path] of expected.entries()) {
      if (actual[index] === path) continue
      problems.push(`sw.js imports ${String(actual[index])} at position ${index}, the manifest implies ${path}`)
      break
    }
  }
  if (problems.length > 0) {
    problems.push(`sw.js: ${actual.join(', ')}`)
    problems.push(`manifest: ${expected.join(', ')}`)
  }
  return { actual, expected, problems }
}

/** @param {unknown} pattern @returns {boolean} */
function isWebSocketPattern(pattern) {
  return typeof pattern === 'string' && /^wss?:\/\//i.test(pattern)
}

/**
 * Rewrite the Gecko manifest into the one Chromium accepts.
 *
 * The CSP is copied verbatim and guarded rather than regenerated: the project
 * contract is that `content_security_policy.extension_pages` never contains
 * `upgrade-insecure-requests` (it would rewrite the plain-HTTP probe and the
 * `ws://` socket to `https`/`wss`). `scripts/check-manifest.mjs` enforces that
 * on the source tree only — it skips the CSP rule when it validates a directory
 * argument — so the generated target is checked here instead.
 * @param {Record<string, any>} source parsed `packages/extension/manifest.json`
 * @returns {{ manifest: Record<string, any>, notes: string[] }}
 */
export function transformManifest(source) {
  const manifest = JSON.parse(JSON.stringify(source))
  /** @type {string[]} */
  const notes = []

  // Chromium MV3 has exactly one background shape. Firefox has no service
  // worker, so the Gecko target keeps `scripts` and only this target changes.
  const previous = Array.isArray(manifest.background?.scripts) ? manifest.background.scripts : []
  manifest.background = { service_worker: SERVICE_WORKER }
  notes.push(`background: service_worker = ${SERVICE_WORKER} (was ${previous.length} script tag(s))`)

  if (manifest[GECKO_KEY] !== undefined) {
    delete manifest[GECKO_KEY]
    notes.push(`dropped ${GECKO_KEY} (Gecko-only key)`)
  }

  if (Array.isArray(manifest.host_permissions)) {
    const kept = manifest.host_permissions.filter((pattern) => !isWebSocketPattern(pattern))
    if (kept.length !== manifest.host_permissions.length) {
      notes.push(
        `host_permissions: dropped ${manifest.host_permissions.length - kept.length} ws:// or wss:// pattern(s), kept ${kept.length}`,
      )
      manifest.host_permissions = kept
    }
  }

  // Every context needs the engine shim before any other script. Gecko gets it
  // from the manifest once the manifest lists it; Chromium below 148 needs it
  // for both the `browser` namespace and promise replies, so the generated
  // content-script list carries it first. A manifest that already starts with
  // it is left alone, and a mid-list entry is moved instead of duplicated.
  if (Array.isArray(manifest.content_scripts)) {
    for (const group of manifest.content_scripts) {
      if (!Array.isArray(group.js) || group.js[0] === PLATFORM_SCRIPT) continue
      const rest = group.js.filter((path) => path !== PLATFORM_SCRIPT)
      group.js = [PLATFORM_SCRIPT, ...rest]
      notes.push(`content_scripts: prepended ${PLATFORM_SCRIPT}`)
    }
  }

  const policy = manifest.content_security_policy?.extension_pages
  if (typeof policy !== 'string' || policy === '') {
    throw new Error(
      'content_security_policy.extension_pages is missing: the MV3 default contains upgrade-insecure-requests and would rewrite the bridge ws:// to wss://',
    )
  }
  if (/upgrade-insecure-requests/i.test(policy)) {
    throw new Error(
      'content_security_policy.extension_pages contains upgrade-insecure-requests, which rewrites the bridge ws:// to wss://',
    )
  }
  notes.push('content_security_policy.extension_pages: copied verbatim')

  return { manifest, notes }
}

/**
 * Notes about the source tree itself, printed once per build: they explain why
 * a generated manifest may differ from the source in the script lists.
 * @param {Record<string, any>} source
 * @returns {string[]}
 */
export function sourceManifestNotes(source) {
  /** @type {string[]} */
  const notes = []
  const background = Array.isArray(source.background?.scripts) ? source.background.scripts : []
  if (background[0] !== PLATFORM_SCRIPT) {
    notes.push(
      `manifest.json background.scripts does not start with ${PLATFORM_SCRIPT}: the Firefox event page does not need the shim, the Chromium service worker imports it first`,
    )
  }
  const groups = Array.isArray(source.content_scripts) ? source.content_scripts : []
  if (groups.some((group) => Array.isArray(group.js) && group.js[0] !== PLATFORM_SCRIPT)) {
    notes.push(
      `manifest.json content_scripts does not start with ${PLATFORM_SCRIPT}: the Chromium target prepends it, the Firefox target runs without it`,
    )
  }
  return notes
}

/**
 * Read the optional `--target firefox|chromium` flag.
 * @param {string[]} argv
 * @returns {string | undefined}
 */
function parseTarget(argv) {
  /** @type {string | undefined} */
  let value
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--target') {
      value = argv[index + 1]
      index += 1
      continue
    }
    if (argument.startsWith('--target=')) {
      value = argument.slice('--target='.length)
      continue
    }
    throw new Error(`unknown argument ${argument} (usage: build-extension.mjs [--target firefox|chromium])`)
  }
  if (value === undefined) return undefined
  if (!TARGETS.includes(value)) throw new Error(`unknown target ${value}; expected one of ${TARGETS.join(', ')}`)
  return value
}

/**
 * Build one target directory.
 * @param {string} target
 * @param {Record<string, any>} source parsed source manifest
 * @returns {Promise<void>}
 */
async function buildTarget(target, source) {
  const destination = join(distDir, target)
  // A stale file from an older build would ship; every target is rebuilt from
  // nothing so the directory is exactly what this run copied.
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  const files = await copyTree(sourceDir, destination)
  const label = relative(root, destination).split('\\').join('/')

  if (target === 'firefox') {
    console.log(`build-extension: ${label}: ${files.length} file(s), manifest.json copied unchanged`)
    return
  }

  const { manifest, notes } = transformManifest(source)
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`build-extension: ${label}: ${files.length} file(s), manifest.json rewritten`)
  for (const note of notes) console.log(`  ${note}`)
}

/**
 * Validate and build.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function build(argv) {
  const only = parseTarget(argv)
  const targets = only === undefined ? [...TARGETS] : [only]
  const manifestSource = await readFile(join(sourceDir, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestSource.replace(/^\uFEFF/, ''))
  const swSource = await readFile(join(sourceDir, SERVICE_WORKER), 'utf8')

  const comparison = compareServiceWorkerScripts(swSource, manifest.background?.scripts)
  if (comparison.problems.length > 0) {
    console.error('build-extension: the service worker does not mirror the manifest background order:')
    for (const problem of comparison.problems) console.error(`  - ${problem}`)
    console.error(`  Fix by editing ${SERVICE_WORKER} or manifest.json so both agree.`)
    throw new Error('service worker script list is out of date')
  }
  console.log(`build-extension: service worker mirrors manifest.background.scripts (${comparison.actual.length} files)`)

  for (const note of sourceManifestNotes(manifest)) console.log(`build-extension: note: ${note}`)
  for (const target of targets) await buildTarget(target, manifest)
}

// Importable for the tests that check the rules above; only a direct run builds.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()

if (invokedDirectly) {
  try {
    await build(process.argv.slice(2))
  } catch (error) {
    console.error(`build-extension: ${error.message}`)
    process.exitCode = 1
  }
}
