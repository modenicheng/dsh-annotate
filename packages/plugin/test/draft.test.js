/**
 * Pin what a queued mention becomes inside a composer.
 *
 * The Client half writes drafts as *documents*, not as text: a mention only
 * turns into a chip because it is carried as a reference span inside the
 * clipboard text. These tests pin that arithmetic — offsets, ordering, the
 * separator, and the refusals — without a browser.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(dirname(here), 'client.js')

/**
 * Load `client.js` the way the page does — through the module table — and
 * return the module its factory builds.
 */
async function loadClient() {
  const code = await readFile(clientPath, 'utf8')
  let spec
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          spec = value
        },
      },
      location: { origin: 'http://127.0.0.1:0' },
      addEventListener() {},
    },
    document: { documentElement: { setAttribute() {} }, addEventListener() {} },
    setInterval: () => 0,
    clearInterval() {},
  }
  sandbox.globalThis = sandbox
  vm.runInContext(code, vm.createContext(sandbox), { filename: 'client.js' })
  assert.equal(spec?.id, 'dsh-marker', 'the module registers itself under its id')
  return spec.factory(() => ({ createElement() {} }))
}

/** @param {string} id */
function entry(id) {
  const mention = `@[批注 · “${id}”](dsh-anno:${id})`
  return { id, mention, label: `批注 · “${id}”`, createdAt: 0 }
}

/** A composer holding exactly `draft` with no chips. */
function input(draft = '', extra = {}) {
  return { draft, occurrences: [], phase: 'plain', ...extra }
}

/**
 * Detach a value from the sandbox realm.
 *
 * `assert.deepEqual` compares prototypes, and every array the Client half
 * returns belongs to the VM's realm, not this one.
 * @param {unknown} value
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('an empty draft becomes one chip, at the start', async () => {
  const { composeDraft } = await loadClient()
  const item = entry('an-20261119-aaaaaa')
  const plan = composeDraft(input(), [item])

  assert.equal(plan.text, item.mention, 'the clipboard projection is the mention itself')
  assert.deepEqual(plain(plan.references), [
    {
      source: 'reference',
      ref: item.mention,
      offset: 0,
      length: item.mention.length,
      label: item.label,
      clipboardText: item.mention,
    },
  ])
  assert.deepEqual(plain(plan.ack), [item.id])
})

test('a drafted question keeps its text and the chip follows on its own line', async () => {
  const { composeDraft } = await loadClient()
  const item = entry('an-20261119-bbbbbb')
  const plan = composeDraft(input('为什么这个接口会超时？'), [item])

  assert.equal(plan.text, `为什么这个接口会超时？\n${item.mention}`)
  const [reference] = plan.references
  assert.equal(reference.offset, '为什么这个接口会超时？\n'.length)
  assert.equal(plan.text.slice(reference.offset, reference.offset + reference.length), item.mention)
})

test('a draft that already ends with a newline gains no blank line', async () => {
  const { composeDraft } = await loadClient()
  const item = entry('an-20261119-cccccc')
  const plan = composeDraft(input('第一段\n'), [item])
  assert.equal(plan.text, `第一段\n${item.mention}`)
})

test('chips already in the draft keep their spans', async () => {
  const { composeDraft } = await loadClient()
  const existing = {
    source: 'reference',
    ref: '@package.json',
    offset: 3,
    length: 13,
    label: 'package.json',
    clipboardText: '@package.json',
  }
  const draft = '看下 @package.json 的脚本'
  const item = entry('an-20261119-dddddd')
  const plan = composeDraft(input(draft, { occurrences: [existing] }), [item])

  assert.deepEqual(plan.references[0], existing, 'an existing chip is carried through untouched')
  const appended = plan.references[1]
  assert.equal(appended.ref, item.mention)
  assert.equal(plan.text.slice(appended.offset, appended.offset + appended.length), item.mention)
})

test('a mention the draft already carries is acknowledged, not inserted twice', async () => {
  const { composeDraft } = await loadClient()
  const item = entry('an-20261119-eeeeee')
  const plan = composeDraft(
    input('hi', {
      occurrences: [
        {
          source: 'reference',
          ref: item.mention,
          offset: 3,
          length: item.mention.length,
          label: item.label,
          clipboardText: item.mention,
        },
      ],
    }),
    [item],
  )

  assert.equal(plan.text, undefined, 'nothing to write')
  assert.deepEqual(plain(plan.ack), [item.id], 'but the entry is still accounted for')
})

test('several entries land in queue order', async () => {
  const { composeDraft } = await loadClient()
  const first = entry('an-20261119-ffffff')
  const second = entry('an-20261119-gggggg')
  const plan = composeDraft(input(), [first, second])

  assert.equal(plan.text, `${first.mention}\n${second.mention}`)
  assert.deepEqual(plain(plan.references.map((reference) => [reference.offset, reference.length])), [
    [0, first.mention.length],
    [first.mention.length + 1, second.mention.length],
  ])
  assert.deepEqual(plain(plan.ack), [first.id, second.id])
})

test('a busy composer is left alone', async () => {
  const { composeDraft } = await loadClient()
  const item = entry('an-20261119-hhhhhh')
  for (const state of [
    input('', { phase: 'submitting' }),
    input('', { phase: 'adjudicating' }),
    input('', { phase: 'claimed', claim: { name: 'goal', token: '/goal ' } }),
  ]) {
    assert.equal(composeDraft(state, [item]), undefined, `phase ${state.phase} refuses the write`)
  }
})

test('entries with no identity or no mention are ignored, not acknowledged', async () => {
  const { composeDraft } = await loadClient()
  const plan = composeDraft(input(), [
    { mention: '@[x](dsh-anno:an-1)' },
    { id: 'an-2', mention: '' },
    { id: 'an-3' },
    null,
  ])
  assert.deepEqual(plain(plan.ack), [], 'nothing was handled')
  assert.equal(plan.text, undefined)
})
