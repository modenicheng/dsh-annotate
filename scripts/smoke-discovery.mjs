/**
 * Verify a booted host's discovery artifacts from the command line.
 *
 * The endpoint record and the locator only exist inside a running host, so they
 * cannot be exercised by unit tests alone. Start a host whose port the launcher
 * chose, then run this:
 *
 *   dsh --profile anno --port 0 --no-open      # in one terminal
 *   node scripts/smoke-discovery.mjs           # in another
 *
 * The script reads `$DSH_HOME/ext-bridge-endpoint.json`, checks that no field
 * anywhere contains something shaped like the bridge token, probes the locator
 * ports, and requires the record, the locator answer, and `/ext/anno/health` to
 * agree on one `instanceId` — the three artifacts are useless if they disagree
 * about which process they describe. It also proves the locator refuses what it
 * must refuse: a foreign `Host`, `POST`, `HEAD`, and any other path.
 *
 * Exit code is non-zero when any check fails.
 */

import { readFile, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  DISCOVERY_APP,
  ENDPOINT_FILE,
  HEALTH_PATH,
  LOCATE_PATH,
  LOCATE_PORTS,
  PROTOCOL_VERSION,
  WS_PATH,
  isInstanceId,
} from '../packages/protocol/src/index.js'

/** Anything this long and hex is shaped like the 32-byte bridge token. */
const TOKEN_SHAPE = /\b[0-9a-f]{64}\b/i

const USAGE = `usage: node scripts/smoke-discovery.mjs [--port <locator-port>]

Reads $DSH_HOME/${ENDPOINT_FILE} and checks the host's discovery answer.
Start the host first: dsh --profile <name> --port 0 --no-open`

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}
const portFlag = args.indexOf('--port')
const preferredPort = portFlag === -1 ? undefined : Number(args[portFlag + 1])
if (portFlag !== -1 && (!Number.isInteger(preferredPort) || preferredPort <= 0 || preferredPort > 65_535)) {
  console.error(USAGE)
  process.exit(1)
}

let total = 0
let failed = 0
/**
 * @param {string} name what was checked
 * @param {boolean} ok
 * @param {string} [detail] one short fact a reader needs when it fails
 */
function check(name, ok, detail = '') {
  total += 1
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * One HTTP request with a hard deadline. A refused port is a normal answer
 * during discovery, so the caller decides whether the rejection is fatal.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, timeout?: number }} [options]
 * @returns {Promise<{ status: number, headers: Record<string, any>, text: string }>}
 */
function request(url, { method = 'GET', headers = {}, timeout = 1_500 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const call = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        agent: false,
        timeout,
        headers,
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text })
        })
      },
    )
    call.on('timeout', () => call.destroy(new Error('timed out')))
    call.on('error', reject)
    call.end()
  })
}

/** @param {string} value */
function isLoopbackOrigin(value) {
  try {
    return new URL(value).hostname === '127.0.0.1'
  } catch {
    return false
  }
}

/**
 * @param {string} origin
 * @returns {string} the websocket URL this host must publish for that origin
 */
function webSocketUrlOf(origin) {
  const parsed = new URL(origin)
  return `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}${WS_PATH}`
}

const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const recordPath = join(home, ENDPOINT_FILE)

let recordText
try {
  recordText = await readFile(recordPath, 'utf8')
} catch (error) {
  console.error(`FAIL endpoint record readable — ${recordPath}: ${error.message}`)
  console.error(`\n${USAGE}`)
  process.exit(1)
}

/** @type {Record<string, any>} */
let record
try {
  record = JSON.parse(recordText)
} catch (error) {
  console.error(`FAIL endpoint record is JSON — ${recordPath}: ${error.message}`)
  process.exit(1)
}

check('endpoint record readable', true, recordPath)
check('record names this application', record.app === DISCOVERY_APP, String(record.app))
check('record carries the protocol version', record.version === PROTOCOL_VERSION, String(record.version))
check('record carries a 16-hex instanceId', isInstanceId(record.instanceId), String(record.instanceId))
check('record carries a pid', Number.isInteger(record.pid) && record.pid > 0, String(record.pid))
check('record carried no token', !TOKEN_SHAPE.test(recordText))
check(
  'record names a loopback origin',
  typeof record.origin === 'string' && isLoopbackOrigin(record.origin),
  String(record.origin),
)
check('record wsUrl matches its origin', record.wsUrl === webSocketUrlOf(record.origin), String(record.wsUrl))
check(
  'record startedAt is a timestamp',
  typeof record.startedAt === 'string' && !Number.isNaN(Date.parse(record.startedAt)),
  String(record.startedAt),
)

if (process.platform === 'win32') {
  console.log('skip  record mode 0600 — Windows inherits the profile ACL instead')
} else {
  const mode = (await stat(recordPath)).mode & 0o777
  check('record mode is 0600', mode === 0o600, mode.toString(8).padStart(4, '0'))
}

// ── the locator ─────────────────────────────────────────────────────────────

const candidates =
  preferredPort === undefined ? LOCATE_PORTS : [preferredPort, ...LOCATE_PORTS.filter((port) => port !== preferredPort)]
/** @type {{ port: number, body: any, text: string, headers: Record<string, any> }[]} */
const answers = []
/** @type {{ port: number, error: string }[]} */
const reachable = []
for (const port of candidates) {
  try {
    const response = await request(`http://127.0.0.1:${port}${LOCATE_PATH}`, {
      headers: { host: `127.0.0.1:${port}` },
      timeout: 700,
    })
    reachable.push({ port, error: `HTTP ${response.status}` })
    if (response.status !== 200) continue
    answers.push({ port, headers: response.headers, text: response.text, body: JSON.parse(response.text) })
  } catch (error) {
    reachable.push({ port, error: error instanceof Error ? error.message : String(error) })
  }
}

check(
  'a locator answers on a discovery port',
  answers.length > 0,
  answers.length > 0 ? `port ${answers[0].port}` : candidates.map((port) => `${port}: refused`).join(', '),
)
if (answers.length === 0) {
  console.error(
    '\nThe record exists but nothing answers. A host binds a locator only when its port is not\n' +
      `${LOCATE_PORTS[0]}–${LOCATE_PORTS.at(-1)}, the bind address is 127.0.0.1, and config \`discovery\` is not \`off\`.\n` +
      'All three ports taken by other processes looks the same from here.',
  )
  console.log(`\n${total - failed}/${total} checks passed`)
  process.exit(1)
}

const answer = answers.find((candidate) => candidate.body?.instanceId === record.instanceId) ?? answers[0]
const body = answer.body ?? {}

check('locator names this application', body.app === DISCOVERY_APP, String(body.app))
check('locator carries the protocol version', body.version === PROTOCOL_VERSION, String(body.version))
check('locator instanceId matches the record', body.instanceId === record.instanceId, `${String(body.instanceId)}`)
check('locator origin matches the record', body.origin === record.origin, String(body.origin))
check('locator wsUrl matches the record', body.wsUrl === record.wsUrl, String(body.wsUrl))
check(
  'locator profile is a label or null',
  body.profile === null || typeof body.profile === 'string',
  String(body.profile),
)
check(
  'locator focusAt is a timestamp or null',
  body.focusAt === null || (typeof body.focusAt === 'string' && !Number.isNaN(Date.parse(body.focusAt))),
  String(body.focusAt),
)
check('locator carried no token', !TOKEN_SHAPE.test(answer.text))
check('locator sends no CORS header', answer.headers['access-control-allow-origin'] === undefined)
check('locator forbids caching', answer.headers['cache-control'] === 'no-store')

// ── the refusals ────────────────────────────────────────────────────────────

const target = `http://127.0.0.1:${answer.port}${LOCATE_PATH}`
const foreign = await request(target, { headers: { host: 'evil.example' }, timeout: 700 })
check('a foreign Host is refused', foreign.status === 403, `HTTP ${foreign.status}`)
const rebinding = await request(target, { headers: { host: '127.0.0.1.evil.example' }, timeout: 700 })
check('a rebinding Host is refused', rebinding.status === 403, `HTTP ${rebinding.status}`)
const posted = await request(target, { method: 'POST', headers: { host: `127.0.0.1:${answer.port}` }, timeout: 700 })
check('POST is refused with 405', posted.status === 405, `HTTP ${posted.status}`)
check('the 405 names the allowed method', posted.headers.allow === 'GET', String(posted.headers.allow))
const headed = await request(target, { method: 'HEAD', headers: { host: `127.0.0.1:${answer.port}` }, timeout: 700 })
check('HEAD is refused with 405', headed.status === 405, `HTTP ${headed.status}`)
const other = await request(`http://127.0.0.1:${answer.port}/ext/anno/nope`, {
  headers: { host: `127.0.0.1:${answer.port}` },
  timeout: 700,
})
check('any other path is 404', other.status === 404, `HTTP ${other.status}`)

// ── the health answer ───────────────────────────────────────────────────────

let health
try {
  const response = await request(`${record.origin}${HEALTH_PATH}`)
  check('health answers at the record origin', response.status === 200, `HTTP ${response.status}`)
  health = JSON.parse(response.text)
} catch (error) {
  check('health answers at the record origin', false, error instanceof Error ? error.message : String(error))
}

if (health !== undefined) {
  check(
    'health carries this host instanceId',
    health.instanceId === record.instanceId,
    health.instanceId === undefined
      ? 'absent: this host predates M4.5a'
      : `${String(health.instanceId)} vs ${record.instanceId}`,
  )
  check('health advertises the same wsUrl', health.wsUrl === record.wsUrl, String(health.wsUrl))
}

console.log('')
if (failed === 0) {
  console.log(
    `smoke-discovery: ${total} checks passed (record, locator ${answer.port}, instanceId ${record.instanceId})`,
  )
} else {
  console.log(`smoke-discovery: ${total - failed}/${total} checks passed, ${failed} failed`)
  process.exitCode = 1
}
