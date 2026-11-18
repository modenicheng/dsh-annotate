/**
 * A minimal RFC 6455 server, scoped to what the annotation bridge needs:
 * one text-frame channel per browser, no extensions, no subprotocols.
 *
 * Why not `ws`: the bundle installs into a DSH profile, and a registry
 * dependency turns an offline install into a failure. This file is ~200 lines
 * of the parts of the protocol actually used (handshake, text frames, ping,
 * pong, close), and it is exercised against Node's own WebSocket client.
 */

import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }

/**
 * Compute the `Sec-WebSocket-Accept` value for a client key.
 * @param {string} key
 */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

/**
 * Is this upgrade request a well-formed websocket handshake?
 * @param {import('node:http').IncomingMessage} request
 */
export function isWebSocketUpgrade(request) {
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase()
  return (
    upgrade === 'websocket' &&
    typeof request.headers['sec-websocket-key'] === 'string' &&
    String(request.headers['sec-websocket-version'] ?? '') === '13'
  )
}

/**
 * Encode one unmasked server frame.
 * @param {number} opcode
 * @param {Buffer} payload
 */
export function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/**
 * One connected browser.
 */
class Connection {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{ maxPayload: number, log: { warn: Function } }} options
   */
  constructor(socket, { maxPayload, log }) {
    this.socket = socket
    this.maxPayload = maxPayload
    this.log = log
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentBytes = 0
    this.closed = false
    /** @type {(text: string) => void} */
    this.onmessage = () => {}
    /** @type {(code: number, reason: string) => void} */
    this.onclose = () => {}
    /** @type {number} */
    this.isAlive = true

    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => this.#finish(1006, 'socket closed'))
    socket.on('error', (error) => {
      this.log.warn(`annotations: ws transport error: ${error.message}`)
      this.#finish(1006, 'transport error')
    })
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (!this.closed) {
      const frame = this.#decode()
      if (frame === undefined) return
      this.#dispatch(frame)
    }
  }

  /**
   * Pull one complete frame out of the buffer.
   * @returns {{ fin: boolean, opcode: number, payload: Buffer } | undefined}
   */
  #decode() {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined
    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    if ((first & 0x70) !== 0) {
      this.close(1002, 'reserved bits set')
      return undefined
    }
    const masked = (second & 0x80) !== 0
    if (!masked) {
      // Clients must mask; an unmasked frame is a protocol error.
      this.close(1002, 'client frames must be masked')
      return undefined
    }
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return undefined
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return undefined
      const wide = buffer.readBigUInt64BE(offset)
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009, 'frame too large')
        return undefined
      }
      length = Number(wide)
      offset += 8
    }
    if (length > this.maxPayload) {
      this.close(1009, 'frame too large')
      return undefined
    }
    if (buffer.length < offset + 4 + length) return undefined
    const mask = buffer.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) payload[index] = buffer[offset + index] ^ mask[index & 3]
    this.buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }

  /** @param {{ fin: boolean, opcode: number, payload: Buffer }} frame */
  #dispatch(frame) {
    switch (frame.opcode) {
      case OPCODE.text:
      case OPCODE.binary:
        if (frame.fin) {
          this.#deliver(frame.opcode, frame.payload)
        } else {
          this.fragments = [frame.payload]
          this.fragmentBytes = frame.payload.length
        }
        return
      case OPCODE.continuation: {
        this.fragments.push(frame.payload)
        this.fragmentBytes += frame.payload.length
        if (this.fragmentBytes > this.maxPayload) {
          this.close(1009, 'fragmented frame too large')
          return
        }
        if (frame.fin) {
          const payload = Buffer.concat(this.fragments)
          this.fragments = []
          this.fragmentBytes = 0
          this.#deliver(OPCODE.text, payload)
        }
        return
      }
      case OPCODE.ping:
        this.socket.write(encodeFrame(OPCODE.pong, frame.payload))
        return
      case OPCODE.pong:
        this.isAlive = true
        return
      case OPCODE.close: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000
        this.#finish(code, 'peer closed')
        return
      }
      default:
        this.close(1002, `unsupported opcode ${frame.opcode}`)
    }
  }

  /** @param {number} opcode @param {Buffer} payload */
  #deliver(opcode, payload) {
    if (opcode === OPCODE.binary) {
      this.close(1003, 'binary frames are not supported')
      return
    }
    try {
      this.onmessage(payload.toString('utf8'))
    } catch (error) {
      this.log.warn(`annotations: ws handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** @param {string} text */
  send(text) {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(OPCODE.text, Buffer.from(text, 'utf8')))
    } catch (error) {
      this.log.warn(`annotations: ws write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ping() {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(OPCODE.ping, Buffer.alloc(0)))
    } catch {
      // The close handler cleans up.
    }
  }

  /** @param {number} code @param {string} reason */
  close(code, reason) {
    if (this.closed) return
    const payload = Buffer.alloc(2 + Math.min(Buffer.byteLength(reason), 123))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2, 'utf8')
    try {
      this.socket.write(encodeFrame(OPCODE.close, payload))
    } catch {
      // Already gone.
    }
    this.#finish(code, reason)
  }

  terminate() {
    this.#finish(1006, 'terminated')
  }

  /** @param {number} code @param {string} reason */
  #finish(code, reason) {
    if (this.closed) return
    this.closed = true
    this.socket.end()
    this.onclose(code, reason)
  }
}

/**
 * Handle one already-authorized upgrade.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{ onConnection: (connection: Connection) => void, maxPayload: number, log?: { warn: Function } }} options
 */
export function handleUpgrade(request, socket, head, options) {
  const log = options.log ?? { warn() {} }
  if (!isWebSocketUpgrade(request)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const key = String(request.headers['sec-websocket-key'])
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ]
  socket.write(`${headers.join('\r\n')}\r\n\r\n`)
  socket.setNoDelay(true)
  socket.setTimeout(0)
  const connection = new Connection(socket, { maxPayload: options.maxPayload, log })
  if (head.length > 0) connection.socket.unshift(head)
  options.onConnection(connection)
}

export { Connection }
