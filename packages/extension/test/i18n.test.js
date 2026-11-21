/**
 * The popup language table and its static markup, kept in step.
 *
 * A missing key in one language is invisible until the popup is opened in that
 * language, and a `data-i18n` attribute with no table entry paints the raw key
 * over a control. Both are checked without a browser. The content overlay has
 * its own table in `content/ui/strings.js`; this file covers the popup surface.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

async function loadI18n() {
  const sandbox = {}
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  const code = await readFile(join(extensionRoot, 'src/shared/i18n.js'), 'utf8')
  vm.runInContext(code, sandbox, { filename: 'src/shared/i18n.js' })
  return sandbox.__DSH_I18N__
}

test('the popup table ships the same keys in English and Chinese', async () => {
  const i18n = await loadI18n()
  assert.deepEqual(Object.keys(i18n.POPUP.zh).sort(), Object.keys(i18n.POPUP.en).sort())
})

test('every data-i18n hook in popup.html has a popup table entry', async () => {
  const i18n = await loadI18n()
  const html = await readFile(join(extensionRoot, 'src/popup/popup.html'), 'utf8')
  const keys = new Set()
  for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) keys.add(match[1])
  assert.ok(keys.size > 20, 'the static markup still carries its translated labels')
  for (const key of keys) {
    assert.ok(Object.hasOwn(i18n.POPUP.en, key), `popup.html uses missing key ${key}`)
    assert.ok(Object.hasOwn(i18n.POPUP.zh, key), `popup.html uses missing zh key ${key}`)
  }
})

test('the English markup matches the English table, so the fallback cannot drift', async () => {
  const i18n = await loadI18n()
  const html = await readFile(join(extensionRoot, 'src/popup/popup.html'), 'utf8')
  const english = i18n.make('en')
  const normalize = (value) => value.replace(/\s+/g, ' ').trim()
  let checked = 0
  for (const match of html.matchAll(/<(\w+)([^>]*?)data-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const [, , , key, inner] = match
    // Nested markup would make `inner` a fragment rather than the label itself.
    assert.ok(!inner.includes('<'), `${key} carries nested markup; the table holds plain text`)
    assert.equal(normalize(inner), normalize(english(key)), `popup.html fallback for ${key} drifted from the table`)
    checked += 1
  }
  assert.ok(checked > 20, 'the check saw the static labels, not an empty match')
})

test('format replaces named placeholders and leaves unknown ones alone', async () => {
  const i18n = await loadI18n()
  assert.equal(i18n.format('Deleted {n}, {failed} failed', { n: 3, failed: 1 }), 'Deleted 3, 1 failed')
  assert.equal(i18n.format('Deleted {n}'), 'Deleted {n}')
  assert.equal(i18n.format('no braces', { n: 1 }), 'no braces')
})

test('zh* locales pick the Chinese table; everything else is English', async () => {
  const i18n = await loadI18n()
  assert.equal(i18n.pickLanguage('zh-CN'), 'zh')
  assert.equal(i18n.pickLanguage('zh-Hant-TW'), 'zh')
  assert.equal(i18n.pickLanguage('en-US'), 'en')
  assert.equal(i18n.pickLanguage('de'), 'en')
  assert.equal(i18n.pickLanguage(undefined), 'en')
})

test('make falls back to English and then to the key itself', async () => {
  const i18n = await loadI18n()
  const zh = i18n.make('zh-CN')
  assert.equal(zh('statusIdle'), i18n.POPUP.zh.statusIdle)
  assert.equal(zh('noSuchKey'), 'noSuchKey')
  assert.equal(zh('pending', { n: 2 }), '2 条待发')
})

test('browserLanguage prefers the extension UI language over the page language', async () => {
  const i18n = await loadI18n()
  assert.equal(
    i18n.browserLanguage({ browser: { i18n: { getUILanguage: () => 'zh-CN' } }, navigator: { language: 'en-US' } }),
    'zh-CN',
  )
  assert.equal(i18n.browserLanguage({ navigator: { language: 'en-US' } }), 'en-US')
  assert.equal(
    i18n.browserLanguage({
      browser: {
        i18n: {
          getUILanguage() {
            throw new Error('private window')
          },
        },
      },
      navigator: { language: 'zh-TW' },
    }),
    'zh-TW',
  )
})
