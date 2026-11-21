/**
 * The shortcut format and recorder, pinned without a browser.
 *
 * One canonical string is shared by the popup recorder, `commands.update`, and
 * the content-script keydown match. The three must agree byte for byte or the
 * user records a key that only half the extension listens to, so this drives
 * the real classic script in a `node:vm` context.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

async function loadShortcut() {
  const sandbox = {}
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  const code = await readFile(join(extensionRoot, 'src/shared/shortcut.js'), 'utf8')
  vm.runInContext(code, sandbox, { filename: 'src/shared/shortcut.js' })
  return sandbox.__DSH_SHORTCUT__
}

test('the default is the documented Alt+Shift+A', async () => {
  const shortcut = await loadShortcut()
  assert.equal(shortcut.DEFAULT, 'Alt+Shift+A')
  assert.equal(shortcut.label(undefined), 'Alt+Shift+A')
})

test('normalize canonicalizes case, modifier order, and Command aliases', async () => {
  const shortcut = await loadShortcut()
  assert.equal(shortcut.normalize('shift+alt+a'), 'Alt+Shift+A')
  assert.equal(shortcut.normalize('Alt+Shift+A'), 'Alt+Shift+A')
  assert.equal(shortcut.normalize('Command+Shift+K'), 'Shift+Meta+K')
  assert.equal(shortcut.normalize('F5'), 'F5')
  assert.equal(shortcut.normalize('Control+F1'), 'Ctrl+F1')
})

test('normalize rejects keys a browser command cannot receive or that cannot work', async () => {
  const shortcut = await loadShortcut()
  assert.equal(shortcut.normalize('a'), null)
  assert.equal(shortcut.normalize('Shift+A'), null)
  assert.equal(shortcut.normalize('Alt+Shift+KeyA'), null)
  assert.equal(shortcut.normalize('Alt+Shift'), null)
  assert.equal(shortcut.normalize('Alt+Alt+A'), null)
  assert.equal(shortcut.normalize('Alt+Shift+Q+W'), null)
  assert.equal(shortcut.normalize(''), null)
  assert.equal(shortcut.normalize(undefined), null)
})

test('fromEvent reads the physical key, not the produced character', async () => {
  const shortcut = await loadShortcut()
  assert.equal(shortcut.fromEvent({ code: 'KeyA', altKey: true, shiftKey: true }), 'Alt+Shift+A')
  assert.equal(shortcut.fromEvent({ code: 'Digit1', ctrlKey: true }), 'Ctrl+1')
  assert.equal(shortcut.fromEvent({ code: 'KeyA', key: 'ф', altKey: true, shiftKey: true }), 'Alt+Shift+A')
  assert.equal(shortcut.fromEvent({ code: 'ShiftLeft', shiftKey: true }), null)
  assert.equal(shortcut.fromEvent({ code: 'Tab', shiftKey: true }), null)
  assert.equal(shortcut.fromEvent({ code: 'KeyA', shiftKey: true }), null)
})

test('matches requires the exact modifier set', async () => {
  const shortcut = await loadShortcut()
  assert.equal(shortcut.matches({ code: 'KeyA', altKey: true, shiftKey: true }, 'Alt+Shift+A'), true)
  assert.equal(shortcut.matches({ code: 'KeyA', altKey: true, shiftKey: true }, 'Shift+Alt+A'), true)
  assert.equal(shortcut.matches({ code: 'KeyA', altKey: true, shiftKey: true, ctrlKey: true }, 'Alt+Shift+A'), false)
  assert.equal(shortcut.matches({ code: 'KeyA', altKey: true }, 'Alt+Shift+A'), false)
  assert.equal(shortcut.matches({ code: 'KeyB', altKey: true, shiftKey: true }, 'Alt+Shift+A'), false)
})
