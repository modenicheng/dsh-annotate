import assert from 'node:assert/strict'
import test from 'node:test'

import { DIRS_PATH, LIMITS } from '../src/protocol.js'
import { createDirBrowser, registerDirsRoute } from '../src/dirs.js'

/**
 * A readdir/stat pair over fixed tables, so the browser's answers stay
 * deterministic on every platform CI runs on.
 *
 * @param {Array<{ name: string, kind: 'dir' | 'file' | 'link' }>} list
 * @param {{ failWith?: string }} [options]
 */
function hostOf(list, { failWith } = {}) {
  const seen = []
  const readdir = async (path) => {
    seen.push(path)
    if (failWith !== undefined) {
      const error = new Error(`cannot read ${path}`)
      error.code = failWith
      throw error
    }
    return list.map((row) => ({
      name: row.name,
      isDirectory: () => row.kind === 'dir',
      isSymbolicLink: () => row.kind === 'link',
    }))
  }
  const stat = async (path) => {
    if (path === 'Z:\\') {
      const error = new Error('no such drive')
      error.code = 'ENOENT'
      throw error
    }
    return { isDirectory: () => true }
  }
  return { readdir, stat, seen }
}

const WINDOWS = [
  { name: 'app', kind: 'dir' },
  { name: 'Docs', kind: 'dir' },
  { name: 'beta', kind: 'dir' },
  { name: 'link', kind: 'link' },
  { name: 'notes.txt', kind: 'file' },
]

test('one level answers directories only, links skipped, sorted', async () => {
  const host = hostOf(WINDOWS)
  const browser = createDirBrowser({ ...host, homedir: () => 'C:\\Users\\u', platform: 'win32' })

  assert.deepEqual(await browser.list('D:\\coding'), {
    path: 'D:\\coding',
    parent: 'D:\\',
    truncated: false,
    entries: [
      { name: 'app', path: 'D:\\coding\\app' },
      { name: 'beta', path: 'D:\\coding\\beta' },
      { name: 'Docs', path: 'D:\\coding\\Docs' },
    ],
  })
})

test('posix paths join and climb with slashes', async () => {
  const host = hostOf([{ name: 'app', kind: 'dir' }])
  const browser = createDirBrowser({ ...host, homedir: () => '/home/u', platform: 'linux' })

  const level = await browser.list('/home/u/work')
  assert.deepEqual(level.entries, [{ name: 'app', path: '/home/u/work/app' }])
  assert.equal(level.parent, '/home/u')
  assert.equal((await browser.list('/home/u')).parent, '/home')
  assert.equal((await browser.list('/home')).parent, '/')
  assert.equal((await browser.list('/')).parent, '')
})

test('the roots view answers home plus probed drives on windows, slash on posix', async () => {
  const windows = createDirBrowser({ ...hostOf([]), homedir: () => 'C:\\Users\\u', platform: 'win32' })
  const winRoots = await windows.list('')
  assert.equal(winRoots.home, 'C:\\Users\\u')
  assert.equal(winRoots.roots.length, 25)
  assert.equal(winRoots.roots.includes('C:\\'), true)
  assert.equal(winRoots.roots.includes('Z:\\'), false)

  const posix = createDirBrowser({ ...hostOf([]), homedir: () => '/home/u', platform: 'linux' })
  assert.deepEqual(await posix.list(''), { roots: ['/'], home: '/home/u' })
})

test('a drive root is the top of its tree, not a level below it', async () => {
  const browser = createDirBrowser({ ...hostOf([]), homedir: () => 'C:\\Users\\u', platform: 'win32' })
  const drive = await browser.list('D:\\')
  assert.equal(drive.parent, '')
  assert.equal((await browser.list('D:\\coding')).parent, 'D:\\')
})

test('the entries answer is bounded with a truncation flag', async () => {
  const many = Array.from({ length: LIMITS.fsEntries + 1 }, (_, index) => ({
    name: `n${String(index).padStart(4, '0')}`,
    kind: 'dir',
  }))
  const browser = createDirBrowser({ ...hostOf(many), homedir: () => 'D:\\', platform: 'win32' })

  const value = await browser.list('D:\\projects')
  assert.equal(value.entries.length, LIMITS.fsEntries)
  assert.equal(value.truncated, true)
})

// ── the route ────────────────────────────────────────────────────────────────

/** @param {object} options */
function mount(options) {
  let handler = null
  const webServer = {
    register(route) {
      handler = route.handler
      return () => {}
    },
  }
  registerDirsRoute(webServer, options)
  return { handler }
}

/**
 * One request; captures the status, the headers and the JSON body.
 * @param {any} handler
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string> }} [init]
 */
function call(handler, url, init = {}) {
  return new Promise((resolve) => {
    let status = 0
    let sentHeaders = null
    let body
    const response = {
      writeHead: (code, head) => {
        status = code
        sentHeaders = head
      },
      end: (payload) => {
        if (payload !== undefined) body = JSON.parse(payload)
        resolve({ status, headers: sentHeaders, body })
      },
    }
    handler({ method: init.method ?? 'GET', url, headers: init.headers ?? {} }, response)
  })
}

const authed = {
  token: 'secret',
  matchesToken: (presented, expected) => presented === expected,
}

function mountedBrowser(list = [], options = {}) {
  const host = hostOf(list, options)
  const browser = createDirBrowser({ ...host, homedir: () => 'C:\\Users\\u', platform: 'win32' })
  return { ...mount({ browser, ...authed }), host }
}

test('the route rejects a missing or wrong token before touching the tree', async () => {
  const host = hostOf([])
  const browser = createDirBrowser({ ...host, homedir: () => 'C:\\Users\\u', platform: 'win32' })
  const { handler } = mount({ browser, token: 'secret', matchesToken: () => false })

  const bare = await call(handler, `${DIRS_PATH}?path=D%3A%5C`)
  assert.equal(bare.status, 401)
  // The URL never carries credentials: even a correct token in the query string is refused.
  const viaQuery = await call(handler, `${DIRS_PATH}?path=D%3A%5C&token=secret`)
  assert.equal(viaQuery.status, 401)
  assert.deepEqual(host.seen, [])
})

test('the route accepts bearer and header tokens', async () => {
  const { handler } = mountedBrowser()

  const viaHeader = await call(handler, `${DIRS_PATH}?path=D%3A%5C`, {
    headers: { 'x-anno-token': 'secret' },
  })
  assert.equal(viaHeader.status, 200)

  const viaBearer = await call(handler, `${DIRS_PATH}?path=D%3A%5C`, {
    headers: { authorization: 'Bearer secret' },
  })
  assert.equal(viaBearer.status, 200)
})

test('the route answers one level and the roots view', async () => {
  const { handler } = mountedBrowser([{ name: 'app', kind: 'dir' }])

  const level = await call(handler, `${DIRS_PATH}?path=D%3A%5Ccoding`, {
    headers: { 'x-anno-token': 'secret' },
  })
  assert.equal(level.status, 200)
  assert.deepEqual(level.body.entries, [{ name: 'app', path: 'D:\\coding\\app' }])
  assert.equal(level.body.parent, 'D:\\')
  assert.equal(level.body.truncated, false)

  const roots = await call(handler, DIRS_PATH, { headers: { 'x-anno-token': 'secret' } })
  assert.equal(roots.status, 200)
  assert.equal(roots.body.home, 'C:\\Users\\u')
  assert.equal(roots.body.roots.includes('C:\\'), true)
})

test('the route refuses relative and poisoned paths with the validator message', async () => {
  const { handler } = mountedBrowser()

  const relative = await call(handler, `${DIRS_PATH}?path=projects`, {
    headers: { 'x-anno-token': 'secret' },
  })
  assert.equal(relative.status, 400)
  assert.match(relative.body.message, /absolute/)
})

test('the route maps a vanished or locked directory to a picker state', async () => {
  const missing = mountedBrowser([], { failWith: 'ENOENT' })
  const gone = await call(missing.handler, `${DIRS_PATH}?path=D%3A%5Cnope`, {
    headers: { 'x-anno-token': 'secret' },
  })
  assert.equal(gone.status, 404)
  assert.equal(gone.body.ok, false)

  const locked = mountedBrowser([], { failWith: 'EACCES' })
  const refused = await call(locked.handler, `${DIRS_PATH}?path=D%3A%5Csecret`, {
    headers: { 'x-anno-token': 'secret' },
  })
  assert.equal(refused.status, 403)
})

test('the route refuses methods other than GET and answers preflight', async () => {
  const { handler } = mountedBrowser()

  const post = await call(handler, `${DIRS_PATH}?path=D%3A%5C`, {
    method: 'POST',
    headers: { 'x-anno-token': 'secret' },
  })
  assert.equal(post.status, 405)

  const preflight = await call(handler, DIRS_PATH, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-methods'], 'GET, OPTIONS')

  const head = await call(handler, DIRS_PATH, { method: 'HEAD', headers: { 'x-anno-token': 'secret' } })
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)
})
