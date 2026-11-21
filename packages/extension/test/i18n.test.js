/**
 * The two language tables and the popup's static markup, kept in step.
 *
 * A missing key in one language is invisible until the feature is opened in
 * that language, and a `data-i18n` attribute with no table entry paints the raw
 * key over a control. Both are checked here without a browser.
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

test('each surface ships the same keys in English and Chinese', async () => {
  const i18n = await loadI18n()
  for (const surface of ['UI', 'POPUP']) {
    const table = i18n[surface]
    assert.deepEqual(Object.keys(table.zh).sort(), Object.keys(table.en).sort(), `${surface} drifted between en and zh`)
  }
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
  const zh = i18n.make('popup', 'zh-CN')
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
