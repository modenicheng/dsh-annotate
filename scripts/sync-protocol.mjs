/**
 * Copy the single-file protocol into the three runtime artifacts.
 *
 * Both consumers run without a build step, so the protocol cannot be a
 * workspace dependency: the host plugin is installed into a DSH profile (a
 * separate pnpm workspace) and the extension is loaded directly by Firefox.
 * Copying one file keeps a single source of truth and removes the resolver
 * problem entirely.
 *
 * Firefox content scripts are classic scripts and cannot `import`, so the
 * extension also receives an IIFE build that publishes the same API on
 * `globalThis.__DSH_PROTOCOL__`.
 *
 * `buildArtifacts` is exported so `check-sync.mjs` compares against exactly the
 * text this script writes; two independent implementations of the transform
 * would drift the moment either one changed.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

export const SOURCE_PATH = join(root, 'packages', 'protocol', 'src', 'index.js')

export const BANNER = `// GENERATED FILE — do not edit. Source: packages/protocol/src/index.js\n// Regenerate with: pnpm run sync-protocol\n`

/**
 * @param {string} source the protocol source text
 * @returns {{ path: string, text: string }[]}
 */
export function buildArtifacts(source) {
  const stripExports = source.replace(/^export (const|function|class) /gm, '$1 ')
  const exported = [...source.matchAll(/^export (?:const|function|class) (\w+)/gm)].map((match) => match[1])
  const classic = `${BANNER}(function () {\n'use strict'\n${stripExports}\nglobalThis.__DSH_PROTOCOL__ = { ${exported.join(', ')} }\n})()\n`
  return [
    { path: join(root, 'packages', 'plugin', 'src', 'protocol.js'), text: `${BANNER}${source}` },
    { path: join(root, 'packages', 'extension', 'src', 'shared', 'protocol.js'), text: `${BANNER}${source}` },
    { path: join(root, 'packages', 'extension', 'src', 'shared', 'protocol.global.js'), text: classic },
  ]
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const source = await readFile(SOURCE_PATH, 'utf8')
  for (const artifact of buildArtifacts(source)) {
    await writeFile(artifact.path, artifact.text, 'utf8')
    console.log(`synced ${artifact.path.replace(root, '.')}`)
  }
}
