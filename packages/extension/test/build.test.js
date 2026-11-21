/**
 * The build rules that must not drift.
 *
 * Chromium needs a second manifest and a service-worker entry point, both
 * derived from `manifest.json` by `scripts/build-extension.mjs`. Two things can
 * break that derivation silently: the service worker's literal `importScripts`
 * list drifting from `background.scripts` (the background then loads a
 * different set of files per engine), and the Chromium manifest keeping a key
 * Chromium refuses or losing one the bridge needs (the store rejects it, or the
 * socket cannot reach a plain local host). Both are pure functions of the tree,
 * so they are checked here; the artifact itself is checked by
 * `node scripts/build-extension.mjs && node scripts/check-manifest.mjs dist/chromium`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  PLATFORM_SCRIPT,
  SERVICE_WORKER,
  compareServiceWorkerScripts,
  expectedServiceWorkerScripts,
  parseServiceWorkerScripts,
  transformManifest,
} from '../../../scripts/build-extension.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)
const WEBSOCKET_PATTERN = /^wss?:\/\//i

/** The source manifest, parsed the way the build reads it. */
async function readManifest() {
  const text = await readFile(join(extensionRoot, 'manifest.json'), 'utf8')
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

/** @param {any} value */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

test('the service worker imports the manifest background order, shim first', async () => {
  const manifest = await readManifest()
  const swSource = await readFile(join(extensionRoot, SERVICE_WORKER), 'utf8')
  const comparison = compareServiceWorkerScripts(swSource, manifest.background?.scripts)

  assert.deepEqual(comparison.problems, [], 'sw.js and manifest.background.scripts must agree')
  assert.equal(comparison.actual[0], PLATFORM_SCRIPT, 'the engine shim is the first thing imported')
  assert.deepEqual(comparison.actual, expectedServiceWorkerScripts(manifest.background.scripts))

  // A path that `sw.js` imports but the build does not copy is a Chromium
  // background that dies on its first line.
  for (const path of comparison.actual) await readFile(join(extensionRoot, path))
})

test('the agreement check fails on a missing, reordered, or absent list', async () => {
  const manifest = await readManifest()
  const background = manifest.background.scripts
  const swSource = await readFile(join(extensionRoot, SERVICE_WORKER), 'utf8')
  const declared = parseServiceWorkerScripts(swSource)

  const missing = declared.filter((path) => path !== 'src/background/capture.js')
  const missingSource = `const BACKGROUND_SCRIPTS = [${missing.map((path) => `'${path}'`).join(', ')}]`
  assert.match(compareServiceWorkerScripts(missingSource, background).problems[0], /sw\.js imports \d+ script/)

  const reordered = [...declared]
  const swap = reordered[1]
  reordered[1] = reordered[2]
  reordered[2] = swap
  const reorderedSource = `const BACKGROUND_SCRIPTS = [${reordered.map((path) => `'${path}'`).join(', ')}]`
  assert.match(compareServiceWorkerScripts(reorderedSource, background).problems[0], /position 1/)

  assert.throws(() => parseServiceWorkerScripts('importScripts("/src/background/main.js")'), /BACKGROUND_SCRIPTS/)
})

test('the expected order accepts a manifest that already lists the shim', () => {
  assert.deepEqual(expectedServiceWorkerScripts([PLATFORM_SCRIPT, 'src/background/main.js']), [
    PLATFORM_SCRIPT,
    'src/background/main.js',
  ])
  assert.deepEqual(expectedServiceWorkerScripts(['src/background/main.js']), [
    PLATFORM_SCRIPT,
    'src/background/main.js',
  ])
  assert.deepEqual(expectedServiceWorkerScripts(undefined), [PLATFORM_SCRIPT])
})

test('the Chromium manifest drops what Chromium rejects and keeps the bridge address', async () => {
  const source = await readManifest()
  const { manifest, notes } = transformManifest(source)

  // Chromium MV3 has no `background.scripts`; the service worker carries them.
  assert.deepEqual(plain(manifest.background), { service_worker: SERVICE_WORKER })
  assert.equal(manifest.browser_specific_settings, undefined, 'a Gecko-only key is dropped')
  assert.notEqual(source.browser_specific_settings, undefined, 'the source manifest is not mutated')

  // ws:// and wss:// are not valid match patterns in Chromium; the loopback
  // http(s) entries are what the discovery probe and the session fetch use.
  const expectedPermissions = source.host_permissions.filter((pattern) => !WEBSOCKET_PATTERN.test(pattern))
  assert.deepEqual(plain(manifest.host_permissions), expectedPermissions)
  assert.ok(manifest.host_permissions.every((pattern) => !WEBSOCKET_PATTERN.test(pattern)))
  for (const loopback of ['http://127.0.0.1/*', 'http://localhost/*', 'https://127.0.0.1/*']) {
    assert.ok(manifest.host_permissions.includes(loopback), `${loopback} must stay`)
  }

  // Copied verbatim: this policy must not upgrade the plain-HTTP probe or the
  // ws:// socket, which is why the project declares it explicitly.
  assert.deepEqual(plain(manifest.content_security_policy), plain(source.content_security_policy))
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /upgrade-insecure-requests/i)

  // Every isolated-world context loads the shim before anything else, the
  // transform says so, and the page-world console hook stays untouched (its
  // shim globals must not leak into the page compartment).
  for (const group of manifest.content_scripts) {
    if (group.world === 'MAIN') continue
    assert.equal(group.js[0], PLATFORM_SCRIPT)
  }
  const hookGroup = manifest.content_scripts.find((group) => group.world === 'MAIN')
  assert.ok(hookGroup, 'the MAIN-world console-hook group survives the transform')
  assert.deepEqual(plain(hookGroup), plain(source.content_scripts.find((group) => group.world === 'MAIN')))
  assert.ok(notes.some((note) => note.startsWith('background: service_worker')))
})

test('the console hook is a MAIN-world group the page CSP cannot touch', async () => {
  const source = await readManifest()
  const group = source.content_scripts.find((entry) => entry.world === 'MAIN')

  // An inline <script> injected from the isolated world is blocked (and logged
  // as a CSP violation) by strict-CSP sites; an extension-declared MAIN-world
  // script is not subject to the page policy at all.
  assert.ok(group, 'manifest.json declares the console-hook content_scripts group')
  assert.deepEqual(group.js, ['src/content/console-hook.js'])
  assert.equal(group.run_at, 'document_start', 'early enough to see page-load errors')

  const hook = await readFile(join(extensionRoot, group.js[0]), 'utf8')
  assert.doesNotMatch(hook, /\bimport\b|\bchrome\.|\bbrowser\./, 'page-world script uses no extension APIs')
  assert.match(hook, /__dshAnno:\s*'console'/, 'posts the shape onPageMessage consumes')
})

test('a manifest that already lists the shim keeps a single copy of it', async () => {
  const source = await readManifest()
  const group = source.content_scripts[0]
  const withShim = {
    ...source,
    content_scripts: [{ ...group, js: [PLATFORM_SCRIPT, ...group.js.filter((path) => path !== PLATFORM_SCRIPT)] }],
  }
  const { manifest } = transformManifest(withShim)
  const copies = manifest.content_scripts[0].js.filter((path) => path === PLATFORM_SCRIPT)
  assert.equal(copies.length, 1)
})
