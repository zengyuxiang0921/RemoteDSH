/**
 * Minimal RFC 6455 server-side WebSocket endpoint.
 *
 * The plugin ships no third-party dependency, so this module implements only
 * what the bridge needs: the HTTP upgrade handshake, masked text frames from
 * clients, unmasked text frames to clients, ping/pong liveness and close.
 */
import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0x0a }
const DEFAULT_MAX_PAYLOAD = 8 * 1024 * 1024
const HEARTBEAT_MS = 30000

/**
 * Whether an incoming HTTP request asks for a WebSocket upgrade.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {boolean} true for an upgrade request.
 */
export function isWebSocketUpgrade(req) {
  const upgrade = String(req?.headers?.upgrade ?? '').toLowerCase()
  return upgrade === 'websocket'
}

/**
 * An accepted WebSocket connection.
 */
export class ServerSocket {
  /**
   * Complete the handshake and start reading frames.
   * @param {import('node:http').IncomingMessage} req - upgrade request.
   * @param {import('node:stream').Duplex} socket - raw socket.
   * @param {Buffer} head - bytes already read after the request headers.
   * @param {{ onMessage?: (text: string) => void, onClose?: () => void, maxPayload?: number }} options - callbacks and limits.
   * @returns {ServerSocket | null} connection, or null when the handshake was refused.
   */
  static accept(req, socket, head, options = {}) {
    const key = req?.headers?.['sec-websocket-key']
    const version = String(req?.headers?.['sec-websocket-version'] ?? '')
    if (typeof key !== 'string' || version !== '13') {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      } catch {
        // ignore
      }
      return null
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.setNoDelay?.(true)
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )
    const connection = new ServerSocket(socket, options)
    if (head && head.length > 0) {
      connection.buffer = Buffer.from(head)
      connection.pendingHead = true
    }
    return connection
  }

  /**
   * @param {import('node:stream').Duplex} socket - upgraded socket.
   * @param {{ onMessage?: (text: string) => void, onClose?: () => void, maxPayload?: number }} options - callbacks and limits.
   */
  constructor(socket, options = {}) {
    this.socket = socket
    this.onMessage = options.onMessage
    this.onClose = options.onClose
    this.maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.closed = false
    this.finished = false
    this.alive = true

    this.handleData = (chunk) => this.receive(chunk)
    this.handleClose = () => this.finish()
    socket.on('data', this.handleData)
    socket.on('close', this.handleClose)
    socket.on('error', this.handleClose)

    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        this.terminate()
        return
      }
      this.alive = false
      this.writeFrame(OPCODE.PING, Buffer.alloc(0))
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  /** @returns {boolean} whether the connection still accepts frames. */
  get open() {
    return !this.closed && !this.finished
  }

  /**
   * Parse the upgrade `head` bytes buffered by {@link ServerSocket.accept}.
   *
   * The caller runs this after wiring its own owner object, because a client may
   * send its first frame inside the upgrade request and that frame must not be
   * handled before the owner can answer it.
   */
  prime() {
    if (this.pendingHead !== true) return
    this.pendingHead = false
    const buffered = this.buffer
    this.buffer = Buffer.alloc(0)
    if (buffered.length > 0) this.receive(buffered)
  }

  /**
   * Send a JSON value or a raw string as one text frame.
   * @param {unknown} value - payload.
   */
  send(value) {
    if (!this.open) return
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    this.writeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'))
  }

  /** Start the closing handshake. */
  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    try {
      this.writeFrame(OPCODE.CLOSE, Buffer.from([0x03, 0xe8]))
    } catch {
      // ignore
    }
    try {
      this.socket.end()
    } catch {
      // ignore
    }
  }

  /** Drop the socket without a closing handshake. */
  terminate() {
    try {
      this.socket.destroy()
    } catch {
      // ignore
    }
  }

  /** @param {Buffer} chunk - newly received bytes. */
  receive(chunk) {
    if (this.finished) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (true) {
      if (this.buffer.length < 2) return
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const high = this.buffer.readUInt32BE(2)
        const low = this.buffer.readUInt32BE(6)
        if (high !== 0) {
          this.close()
          return
        }
        length = low
        offset = 10
      }
      if (length > this.maxPayload) {
        this.close()
        return
      }
      let mask = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        mask = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) return
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      this.buffer = this.buffer.subarray(offset + length)
      if (mask !== null) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3]
      }
      this.handleFrame(fin, opcode, payload)
    }
  }

  /**
   * @param {boolean} fin - final fragment flag.
   * @param {number} opcode - frame opcode.
   * @param {Buffer} payload - unmasked payload.
   */
  handleFrame(fin, opcode, payload) {
    this.alive = true
    if (opcode === OPCODE.PING) {
      this.writeFrame(OPCODE.PONG, payload)
      return
    }
    if (opcode === OPCODE.PONG) return
    if (opcode === OPCODE.CLOSE) {
      this.close()
      return
    }
    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY || opcode === OPCODE.CONTINUATION) {
      if (opcode !== OPCODE.CONTINUATION) {
        this.fragmentOpcode = opcode
        this.fragments = [payload]
      } else {
        this.fragments.push(payload)
      }
      if (!fin) return
      const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)
      this.fragments = []
      if (full.length > this.maxPayload) {
        this.close()
        return
      }
      const text = full.toString('utf8')
      try {
        this.onMessage?.(text)
      } catch {
        // listener failures never break the frame loop
      }
      return
    }
    this.close()
  }

  /**
   * @param {number} opcode - frame opcode.
   * @param {Buffer} payload - frame payload.
   */
  writeFrame(opcode, payload) {
    if (this.finished) return
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.alloc(2)
      header[1] = length
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 127
      header.writeUInt32BE(0, 2)
      header.writeUInt32BE(length, 6)
    }
    header[0] = 0x80 | opcode
    try {
      this.socket.write(Buffer.concat([header, payload]))
    } catch {
      this.terminate()
    }
  }

  /** Release the socket once, reporting closure to the owner. */
  finish() {
    if (this.finished) return
    this.finished = true
    this.closed = true
    clearInterval(this.heartbeat)
    try {
      this.socket.off('data', this.handleData)
      this.socket.off('close', this.handleClose)
      this.socket.off('error', this.handleClose)
    } catch {
      // ignore
    }
    try {
      this.socket.destroy()
    } catch {
      // ignore
    }
    try {
      this.onClose?.()
    } catch {
      // ignore
    }
  }
}
