/**
 * Chromium service-worker entry point for the background half.
 *
 * Chromium MV3 rejects `background.scripts` (the Gecko form in manifest.json)
 * and runs one `background.service_worker` instead. This file is the seam
 * between the two shapes: it imports the very files the Firefox manifest lists,
 * in that order, so the implementation exists once and `main.js` stays the last
 * thing that runs.
 *
 * The list is a literal because `importScripts` is synchronous and a classic
 * service worker has no way to read manifest.json before it runs. That
 * duplication is only acceptable while something proves it stays a duplicate:
 * `scripts/build-extension.mjs` fails the build, and
 * `packages/extension/test/build.test.js` fails the test run, when this array
 * and `background.scripts` disagree. Change one, change both.
 *
 * `src/shared/platform.js` leads the list rather than being part of it: it must
 * load before any file reads `browser` (Chrome exposes `browser` only from
 * version 148), and the manifest's list only covers the Gecko script tags.
 * A manifest that lists the shim as well is fine; this array is compared
 * against the manifest with the shim in front either way.
 */
const BACKGROUND_SCRIPTS = [
  'src/shared/platform.js',
  'src/shared/protocol.global.js',
  'src/background/endpoints.js',
  'src/background/discovery.js',
  'src/background/connection.js',
  'src/background/core.js',
  'src/background/socket.js',
  'src/background/outbox.js',
  'src/background/capture.js',
  'src/background/routing.js',
  'src/background/main.js',
]

// A service worker resolves a relative `importScripts` URL against its own URL
// (`/src/background/sw.js`), not against the extension root the manifest paths
// are written relative to, so each path is anchored to the root explicitly.
importScripts(...BACKGROUND_SCRIPTS.map((path) => `/${path}`))
