/**
 * Validate the WebExtension manifest before a release or in CI.
 *
 * Parsing is the easy half: a manifest that references a file that is not in
 * the package fails at load time in the browser, often only on a user's
 * machine. This script walks every file reference it knows about and checks it
 * against the extension directory, including simple `*` / `?` globs used by
 * `web_accessible_resources`.
 *
 * It also guards the extension-page CSP: Firefox's MV3 default is
 * `script-src 'self'; upgrade-insecure-requests;`, and that
 * `upgrade-insecure-requests` rewrites every `ws://` and `http://` request the
 * extension makes into `wss://`/`https://` — including the bridge connection to
 * a plain local `dsh web`. The bug looked like "the websocket is broken"; the
 * console said the request was upgraded. A manifest that declares no policy
 * inherits the default, so the policy must be explicit and must not contain
 * that directive.
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// Optional first argument: validate another unpacked extension directory.
const extensionDir = process.argv[2] === undefined ? join(root, 'packages', 'extension') : resolve(process.argv[2])
const manifestPath = join(extensionDir, 'manifest.json')
const manifestLabel = relative(root, manifestPath).split('\\').join('/') || manifestPath
const sep = '/'

/**
 * @typedef {Record<string, any>} Json
 */

/** @param {unknown} value @returns {value is Json} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} directory
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
async function listFiles(directory, prefix = '') {
  /** @type {string[]} */
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix === '' ? entry.name : `${prefix}${sep}${entry.name}`
    if (entry.isDirectory()) files.push(...(await listFiles(join(directory, entry.name), relativePath)))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files
}

/** @param {string} glob */
function globToRegExp(glob) {
  let pattern = ''
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === '*') {
      if (glob[index + 1] === '*') {
        pattern += '.*'
        index += 1
        if (glob[index + 1] === '/') index += 1
      } else pattern += '[^/]*'
    } else if (character === '?') pattern += '[^/]'
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`)
}

/** @param {unknown} value */
function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const references = new Set()
const warnings = []

/** @param {unknown} value */
function add(value) {
  const path = asString(value)
  if (path === undefined) return
  if (path.includes('__MSG_')) {
    warnings.push(`skipped localized reference ${path}`)
    return
  }
  references.add(path)
}

/** @param {unknown} values */
function addMany(values) {
  if (!Array.isArray(values)) return
  for (const value of values) add(value)
}

/** @param {unknown} value */
function addIcon(value) {
  if (Array.isArray(value)) {
    for (const entry of value) add(entry)
    return
  }
  if (isObject(value)) {
    for (const entry of Object.values(value)) add(entry)
    return
  }
  add(value)
}

let manifest
try {
  const text = (await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, '')
  manifest = JSON.parse(text)
} catch (error) {
  const hint = error.code === 'ENOENT' ? 'the extension package has not been written yet' : error.message
  console.error(`check-manifest: cannot read ${manifestLabel}: ${hint}`)
  process.exit(1)
}

if (!isObject(manifest)) {
  console.error('check-manifest: the manifest must contain a JSON object')
  process.exit(1)
}

const background = isObject(manifest.background) ? manifest.background : {}
add(background.page)
add(background.service_worker)
addMany(background.scripts)

if (Array.isArray(manifest.content_scripts)) {
  for (const entry of manifest.content_scripts) {
    if (!isObject(entry)) continue
    addMany(entry.js)
    addMany(entry.css)
  }
}

for (const key of ['action', 'browser_action', 'page_action']) {
  const entry = isObject(manifest[key]) ? manifest[key] : {}
  add(entry.default_popup)
  addIcon(entry.default_icon)
}

const options = isObject(manifest.options_ui) ? manifest.options_ui : {}
add(options.page)
const sidebar = isObject(manifest.sidebar_action) ? manifest.sidebar_action : {}
add(sidebar.default_panel)
addIcon(sidebar.default_icon)
add(manifest.devtools_page)
addIcon(manifest.icons)
addIcon(manifest.user_scripts?.api_script)

if (isObject(manifest.chrome_url_overrides)) addMany(Object.values(manifest.chrome_url_overrides))
if (Array.isArray(manifest.web_accessible_resources)) {
  for (const entry of manifest.web_accessible_resources) {
    if (typeof entry === 'string') add(entry)
    else if (isObject(entry)) addMany(entry.resources)
  }
}

const locale = asString(manifest.default_locale)
if (locale !== undefined) add(`${sep}_locales/${locale}/messages.json`)

const files = await listFiles(extensionDir)
const fileSet = new Set(files)
/**
 * The CSP rule is this project's contract, so it only applies to this package:
 * the optional directory argument exists to validate an arbitrary unpacked
 * extension, whose policy is its own business.
 */
const projectExtension = process.argv[2] === undefined
/** @type {string[]} */
const problems = projectExtension ? [...cspProblems(manifest)] : []

/**
 * The extension-page CSP must be explicit and must not upgrade insecure
 * requests. Returns one sentence per violation.
 * @param {Json} manifest
 * @returns {string[]}
 */
function cspProblems(manifest) {
  const policy = isObject(manifest.content_security_policy) ? manifest.content_security_policy : undefined
  const extensionPages = policy === undefined ? undefined : asString(policy.extension_pages)
  if (extensionPages === undefined) {
    return [
      'content_security_policy.extension_pages is not declared: the MV3 default contains upgrade-insecure-requests, which rewrites the bridge ws:// to wss:// and breaks a plain local host',
    ]
  }
  if (/upgrade-insecure-requests/i.test(extensionPages)) {
    return [
      'content_security_policy.extension_pages contains upgrade-insecure-requests, which rewrites the bridge ws:// to wss:// and breaks a plain local host',
    ]
  }
  return []
}
let checked = 0

for (const reference of references) {
  const cleaned = reference.replace(/[?#].*$/, '').replace(/^\.?\//, '')
  if (cleaned === '' || cleaned.includes('://') || cleaned.startsWith('data:')) continue
  if (cleaned.split(sep).includes('..')) {
    problems.push(`${reference} escapes the extension directory`)
    continue
  }
  checked += 1
  if (cleaned.includes('*') || cleaned.includes('?')) {
    const matcher = globToRegExp(cleaned)
    if (!files.some((file) => matcher.test(file))) problems.push(`${reference} matches no file`)
    continue
  }
  if (!fileSet.has(cleaned)) problems.push(`${reference} does not exist`)
}

for (const warning of warnings) console.warn(`check-manifest: ${warning}`)

if (problems.length > 0) {
  // Problems are mixed (file references, then the CSP contract), so the header
  // names no single kind.
  console.error(`check-manifest: ${manifestLabel} failed ${problems.length} check(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`check-manifest: ok (${checked} referenced file(s) present, ${files.length} packaged file(s))`)
