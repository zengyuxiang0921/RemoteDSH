/**
 * Server mode: expose this Host's session records over HTTP + WebSocket.
 *
 * Beyond its own sessions the server can act as a relay hub: a peer that
 * advertises `relay.publish` may publish the sessions it chose to share, and a
 * peer that advertises `relay.subscribe` may read them — history requests and
 * live events are forwarded through the server, so no peer ever connects to
 * another peer directly. A relay needs all three: `server.relay.enabled`, the
 * publisher's own scope, and the publisher's consumer list.
 */
import http from 'node:http'
import { ServerSocket, isWebSocketUpgrade } from './ws.js'
import {
  ALL_FEATURES,
  FEATURES,
  MIN_PROTOCOL_VERSION,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  allowsSession,
  isSupportedProtocol,
  negotiateFeatures,
  normalizeFeatures,
  normalizeShare,
  safeEqual,
  shareAllowsConsumer,
  shareAllowsSession,
} from './protocol.js'
import { SessionInventory } from './inventory.js'

const MAX_PEERS = 64
const HELLO_TIMEOUT_MS = 10000
const MAX_LISTED_SESSIONS = 500
const RELAY_TIMEOUT_MS = 30000
let nextPeerId = 0
let nextRelayId = 0

/** One admitted bridge peer. */
class Peer {
  /**
   * @param {BridgeServer} server - owning server.
   * @param {ServerSocket} socket - accepted WebSocket.
   * @param {{ name: string, allow: object }} grant - admitted identity and scope.
   */
  constructor(server, socket, grant) {
    this.server = server
    this.socket = socket
    this.grant = grant
    this.welcomed = false
    this.dead = false
    this.id = `peer-${Date.now().toString(36)}-${++nextPeerId}`
    this.connectedAt = Date.now()
    this.lastActiveAt = this.connectedAt
    this.welcomedAt = null
    this.remoteAddress = 'unknown'
    this.remotePort = null
    this.clientName = null
    this.clientVersion = null
    this.protocol = null
    this.features = []
    this.share = normalizeShare({})
    /** @type {Map<string, object>} sessions this peer currently publishes. */
    this.published = new Map()
    this.historyReads = 0
    this.relayServed = 0
    this.lastHistoryAt = null
    this.hello = setTimeout(() => {
      if (!this.welcomed) this.fail('hello-timeout', '没有在限定时间内完成握手')
    }, HELLO_TIMEOUT_MS)
    this.hello.unref?.()
  }

  /** @param {object} summary - wire session summary. @returns {boolean} visibility. */
  canSee(summary) {
    return allowsSession(this.grant.allow, summary)
  }

  /** @returns {boolean} whether this peer currently offers sessions to others. */
  get publishes() {
    return this.features.includes(FEATURES.RELAY_PUBLISH) && this.share.enabled && this.published.size > 0
  }

  /** @returns {boolean} whether this peer asked for relayed sessions. */
  get subscribes() {
    return this.features.includes(FEATURES.RELAY_SUBSCRIBE)
  }

  /** @param {unknown} value - JSON payload. */
  send(value) {
    if (this.dead || this.socket === null) return
    this.socket.send(value)
  }

  /**
   * Report a protocol failure and close.
   * @param {string} code - machine code.
   * @param {string} message - human text.
   */
  fail(code, message) {
    this.send({ t: 'error', code, message })
    this.close()
  }

  /** @param {object} payload - `welcome` payload without sessions. */
  welcome(payload) {
    this.welcomed = true
    this.welcomedAt = Date.now()
    this.lastActiveAt = this.welcomedAt
    clearTimeout(this.hello)
    this.send(payload)
  }

  close() {
    if (this.dead) return
    this.dead = true
    clearTimeout(this.hello)
    this.socket?.close()
  }

  /** The credential-free description used by the management panel. */
  describe() {
    return {
      id: this.id,
      state: this.dead ? 'closed' : this.welcomed ? 'online' : 'handshaking',
      name: this.clientName ?? this.grant.name,
      identity: this.grant.name,
      version: this.clientVersion,
      protocol: this.protocol,
      features: [...this.features],
      address: this.remoteAddress,
      port: this.remotePort,
      connectedAt: this.connectedAt,
      welcomedAt: this.welcomedAt,
      lastActiveAt: this.lastActiveAt,
      visibleSessions: this.welcomed ? this.server.countVisible(this) : 0,
      publishedSessions: this.published.size,
      share: {
        enabled: this.share.enabled,
        sessions: this.share.sessions,
        cwdPrefixes: [...this.share.cwdPrefixes],
        consumers: [...this.share.consumers],
      },
      scope: { sessions: this.grant.allow.sessions, cwdPrefixes: [...this.grant.allow.cwdPrefixes] },
      historyReads: this.historyReads,
      relayServed: this.relayServed,
      lastHistoryAt: this.lastHistoryAt,
    }
  }
}

/** The bridge HTTP + WebSocket server. */
export class BridgeServer {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {object} config - normalized `server` config.
   * @param {object} log - Cordis logger.
   */
  constructor(ctx, config, log) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.peers = new Set()
    this.sessions = new Map()
    this.inventory = new SessionInventory(ctx, log)
    this.lastListKey = ''
    this.lastError = null
    this.relayEnabled = config.relay?.enabled === true
    this.maxRelaySessions = config.relay?.maxRelaySessions ?? 200
    /** @type {Map<string, { peer: Peer, rid: string, publisherId: string, timer: object }>} */
    this.relayPending = new Map()
    this.refreshing = null
    this.offEvent = null
    this.listTimer = null
    this.http = null
    this.stopped = false
  }

  /** @returns {object} the inventory diagnostic block exposed over HTTP. */
  get diag() {
    return this.inventory.diag
  }

  /** Start listening and streaming. Resolves after the port is bound or failed. */
  async start() {
    if (this.stopped) return
    const { host, port } = this.config
    this.http = http.createServer((req, res) => {
      this.handleHttp(req, res)
    })
    this.http.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head)
    })
    this.http.on('clientError', (_error, socket) => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    })

    await new Promise((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }
      this.http.once('error', (error) => {
        this.log?.warn?.(`远程桥接服务无法监听 ${host}:${port}：${error?.message ?? error}`)
        this.http = null
        settle()
      })
      this.http.listen(port, host, () => {
        this.port = this.http?.address()?.port ?? port
        settle()
      })
    })

    if (this.http === null) return
    if (!this.config.auth.token && !this.config.auth.password && this.config.clients.length === 0) {
      this.log?.warn?.('远程桥接服务未配置任何 token / password，任何能访问该端口的人都能读取会话记录')
    }
    if (this.relayEnabled) {
      this.log?.info?.('远程桥接已允许客户端之间转发会话（server.relay.enabled）')
    }

    this.offEvent = this.ctx.on('session/event', (session, event) => {
      this.broadcastEvent(session, event)
    })
    this.listTimer = setInterval(() => {
      if (this.peers.size === 0) return
      this.refresh().catch(() => {})
    }, this.config.listIntervalMs)
    this.listTimer.unref?.()
    this.log?.info?.(`远程桥接服务已启动：${host}:${this.port}`)
  }

  /**
   * @param {Peer} peer - peer to test.
   * @returns {number} sessions of this Host visible to it.
   */
  countVisible(peer) {
    let count = 0
    for (const summary of this.sessions.values()) if (peer.canSee(summary)) count += 1
    return count
  }

  /** A credential-free view for the authenticated management RPC. */
  snapshot() {
    return {
      enabled: true,
      listening: this.http !== null,
      host: this.config.host,
      port: this.port ?? this.config.port,
      name: this.config.name,
      authRequired: Boolean(this.config.auth.token || this.config.auth.password || this.config.clients.length),
      lastError: this.lastError,
      relay: {
        enabled: this.relayEnabled,
        publishers: [...this.peers].filter((peer) => peer.publishes).length,
        subscribers: [...this.peers].filter((peer) => peer.welcomed && peer.subscribes).length,
        publishedSessions: [...this.peers].reduce((total, peer) => total + peer.published.size, 0),
      },
      peers: [...this.peers].map((peer) => peer.describe()),
    }
  }

  /** Drop one connection; a normally configured client will reconnect later. */
  disconnect(peerId) {
    const peer = [...this.peers].find((item) => item.id === peerId)
    if (peer === undefined) return { ok: false, error: '连接已断开或不存在' }
    peer.fail('admin-disconnect', '已被服务端管理面板断开')
    return { ok: true, peerId }
  }

  /** Stop listening, drop peers and timers. */
  stop() {
    this.stopped = true
    for (const pending of this.relayPending.values()) clearTimeout(pending.timer)
    this.relayPending.clear()
    for (const peer of this.peers) peer.close()
    this.peers.clear()
    if (this.listTimer) clearInterval(this.listTimer)
    this.listTimer = null
    try {
      this.offEvent?.()
    } catch {
      // ignore
    }
    this.offEvent = null
    try {
      this.http?.close()
    } catch {
      // ignore
    }
    this.http = null
  }

  /**
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   */
  handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://bridge.local')
    const send = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (url.pathname === '/health') {
      send(200, { ok: true, name: this.config.name, version: PLUGIN_VERSION, protocol: PROTOCOL_VERSION })
      return
    }
    send(200, {
      ok: true,
      name: this.config.name,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      minProtocol: MIN_PROTOCOL_VERSION,
      features: ALL_FEATURES,
      transport: 'websocket',
      endpoint: '/ws',
      sessions: this.sessions.size,
      peers: this.peers.size,
      relay: this.relayEnabled,
      lastError: this.lastError,
      diag: this.diag,
    })
  }

  /**
   * @param {import('node:http').IncomingMessage} req - upgrade request.
   * @param {import('node:stream').Duplex} socket - raw socket.
   * @param {Buffer} head - buffered bytes.
   */
  handleUpgrade(req, socket, head) {
    if (this.stopped || this.peers.size >= MAX_PEERS || !isWebSocketUpgrade(req)) {
      try {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      } catch {
        // ignore
      }
      return
    }
    const peer = new Peer(this, null, { name: 'pending', allow: { sessions: '*', cwdPrefixes: [] } })
    peer.remoteAddress = String(req.socket.remoteAddress ?? socket.remoteAddress ?? 'unknown')
    peer.remotePort = Number(req.socket.remotePort ?? socket.remotePort) || null
    this.peers.add(peer)
    const ws = ServerSocket.accept(req, socket, head, {
      maxPayload: 1024 * 1024,
      onMessage: (text) => this.handleMessage(peer, text),
      onClose: () => {
        clearTimeout(peer.hello)
        peer.dead = true
        this.peers.delete(peer)
        this.dropPublisher(peer)
      },
    })
    if (ws === null) {
      clearTimeout(peer.hello)
      this.peers.delete(peer)
      return
    }
    peer.socket = ws
    ws.prime()
  }

  /**
   * Tell subscribers that one publisher's contribution is gone.
   * @param {Peer} peer - departing peer.
   */
  dropPublisher(peer) {
    if (peer.published.size === 0) return
    peer.published.clear()
    for (const other of this.peers) {
      if (!other.welcomed || other.dead || !other.subscribes) continue
      other.send({
        t: 'relay/sessions',
        peer: { id: peer.id, name: peer.clientName ?? peer.grant.name },
        sessions: [],
        gone: true,
      })
    }
  }

  /**
   * @param {Peer} peer - peer whose socket produced the frame.
   * @param {string} text - raw JSON text.
   */
  handleMessage(peer, text) {
    if (peer.dead) return
    peer.lastActiveAt = Date.now()
    let message
    try {
      message = JSON.parse(text)
    } catch {
      peer.fail('bad-frame', '无法解析的消息')
      return
    }
    if (message === null || typeof message !== 'object') {
      peer.fail('bad-frame', '消息必须是对象')
      return
    }
    if (!peer.welcomed) {
      this.handleHello(peer, message)
      return
    }
    switch (message.t) {
      case 'ping':
        peer.send({ t: 'pong', at: Date.now() })
        return
      case 'refresh':
        this.refresh().catch(() => {})
        return
      case 'history':
        this.handleHistory(peer, message)
        return
      case 'publish':
        this.handlePublish(peer, message)
        return
      case 'publish/event':
        this.handlePublishEvent(peer, message)
        return
      default:
        peer.send({ t: 'error', code: 'unknown-message', message: `未知消息类型：${String(message.t)}` })
    }
  }

  /**
   * @param {Peer} peer - unauthenticated peer.
   * @param {object} message - `hello` frame.
   */
  handleHello(peer, message) {
    if (message.t !== 'hello') {
      peer.fail('expected-hello', '第一帧必须是 hello')
      return
    }
    if (!isSupportedProtocol(message.v)) {
      peer.fail(
        'protocol-mismatch',
        `协议版本不匹配：本端支持 ${MIN_PROTOCOL_VERSION}-${PROTOCOL_VERSION}，收到 ${String(message.v)}；` +
          `本端能力：${ALL_FEATURES.join(', ')}`,
      )
      return
    }
    const grant = this.authenticate(message)
    if (grant === null) {
      peer.fail('auth-failed', 'token 或 password 不正确')
      return
    }
    peer.grant = grant
    peer.protocol = Number(message.v)
    peer.clientName = typeof message.client?.name === 'string' ? message.client.name.slice(0, 120) : grant.name
    peer.clientVersion = typeof message.client?.version === 'string' ? message.client.version.slice(0, 40) : null
    peer.features = negotiateFeatures(normalizeFeatures(message.features), ALL_FEATURES)
    peer.share = normalizeShare(message.share)
    if (peer.share.enabled && !this.relayEnabled) {
      this.log?.info?.(`${peer.clientName} 想共享会话，但服务端未开启 server.relay.enabled`)
    }
    this.log?.info?.(
      `远程 DSH 已连接：${peer.clientName}（${peer.remoteAddress}）能力：${peer.features.join(', ') || '仅基础'}`,
    )
    this.refresh()
      .catch(() => {})
      .finally(() => {
        if (peer.dead) return
        const sessions = [...this.sessions.values()]
          .filter((summary) => peer.canSee(summary))
          .sort((left, right) => right.updatedAt - left.updatedAt)
        peer.welcome({
          t: 'welcome',
          v: PROTOCOL_VERSION,
          server: { name: this.config.name, version: PLUGIN_VERSION },
          you: { name: grant.name, id: peer.id },
          features: peer.features,
          featuresSupported: ALL_FEATURES,
          sessions,
          relays: peer.subscribes ? this.relaySnapshot(peer) : [],
          diagnostics: this.lastError ?? null,
        })
      })
  }

  /**
   * Resolve the identity and scope of a `hello` frame.
   * @param {object} message - hello frame.
   * @returns {{ name: string, allow: object } | null} grant, or null when refused.
   */
  authenticate(message) {
    const auth = message.auth !== null && typeof message.auth === 'object' ? message.auth : {}
    const token = typeof auth.token === 'string' ? auth.token : ''
    const password = typeof auth.password === 'string' ? auth.password : ''
    const clients = this.config.clients
    if (clients.length > 0) {
      for (const client of clients) {
        if (client.token && !safeEqual(token, client.token)) continue
        if (client.password && !safeEqual(password, client.password)) continue
        if (!client.token && !client.password) continue
        return { name: client.name, allow: client.allow }
      }
      return null
    }
    const expected = this.config.auth
    if (expected.token && !safeEqual(token, expected.token)) return null
    if (expected.password && !safeEqual(password, expected.password)) return null
    const name = typeof message.client?.name === 'string' && message.client.name !== '' ? message.client.name.slice(0, 120) : 'client'
    return { name, allow: this.config.allow }
  }

  /**
   * Publishers one consumer may currently see.
   * @param {Peer} consumer - asking peer.
   * @returns {Array<{ peer: object, sessions: object[] }>} relay catalogue.
   */
  relaySnapshot(consumer) {
    if (!this.relayEnabled) return []
    const out = []
    for (const publisher of this.peers) {
      if (publisher === consumer || !publisher.welcomed || publisher.published.size === 0) continue
      if (!shareAllowsConsumer(publisher.share, consumer.grant.name)) continue
      out.push({
        peer: { id: publisher.id, name: publisher.clientName ?? publisher.grant.name },
        sessions: [...publisher.published.values()].sort((left, right) => right.updatedAt - left.updatedAt),
      })
    }
    return out
  }

  /**
   * Accept a publisher's shared catalogue.
   * @param {Peer} peer - publishing peer.
   * @param {object} message - `publish` frame.
   */
  handlePublish(peer, message) {
    if (!this.relayEnabled) {
      peer.send({ t: 'error', code: 'relay-disabled', message: '服务端未开启 server.relay.enabled' })
      return
    }
    if (!peer.features.includes(FEATURES.RELAY_PUBLISH)) {
      peer.send({ t: 'error', code: 'relay-unsupported', message: '握手未协商 relay.publish 能力' })
      return
    }
    if (!peer.share.enabled) {
      peer.send({ t: 'error', code: 'relay-not-shared', message: '本端未开启 client.share.enabled' })
      return
    }
    const incoming = Array.isArray(message.sessions) ? message.sessions : []
    const next = new Map()
    for (const raw of incoming.slice(0, this.maxRelaySessions)) {
      const summary = this.normalizeRelayed(raw)
      if (summary === null) continue
      if (!shareAllowsSession(peer.share, summary)) continue
      next.set(summary.id, summary)
    }
    peer.published = next
    const frame = {
      t: 'relay/sessions',
      peer: { id: peer.id, name: peer.clientName ?? peer.grant.name },
      sessions: [...next.values()].sort((left, right) => right.updatedAt - left.updatedAt),
    }
    for (const consumer of this.peers) {
      if (consumer === peer || !consumer.welcomed || consumer.dead || !consumer.subscribes) continue
      if (!shareAllowsConsumer(peer.share, consumer.grant.name)) continue
      consumer.send(frame)
    }
  }

  /**
   * Fan one published event out to allowed consumers.
   * @param {Peer} peer - publishing peer.
   * @param {object} message - `publish/event` frame.
   */
  handlePublishEvent(peer, message) {
    if (!this.relayEnabled || !peer.share.enabled) return
    const sessionId = String(message.session ?? '')
    const event = message.event
    if (sessionId === '' || event === null || typeof event !== 'object') return
    if (!peer.published.has(sessionId)) return
    const frame = {
      t: 'relay/event',
      peer: { id: peer.id, name: peer.clientName ?? peer.grant.name },
      session: sessionId,
      event,
    }
    for (const consumer of this.peers) {
      if (consumer === peer || !consumer.welcomed || consumer.dead || !consumer.subscribes) continue
      if (!shareAllowsConsumer(peer.share, consumer.grant.name)) continue
      consumer.send(frame)
    }
  }

  /**
   * Sanitize one relayed summary so a publisher cannot inject extra fields.
   * @param {unknown} value - one `publish.sessions` entry.
   * @returns {object | null} wire summary, or null when malformed.
   */
  normalizeRelayed(value) {
    if (value === null || typeof value !== 'object') return null
    const id = String(value.id ?? '')
    if (id === '') return null
    return {
      id,
      title: typeof value.title === 'string' && value.title !== '' ? value.title.slice(0, 300) : null,
      updatedAt: Number(value.updatedAt) || 0,
      running: value.running === true,
      blank: value.blank === true,
      cwd: typeof value.cwd === 'string' ? value.cwd : null,
      parentId: typeof value.parentId === 'string' ? value.parentId : null,
      origin: value.origin === 'subagent' ? 'subagent' : null,
      preview: typeof value.preview === 'string' ? value.preview.slice(0, 200) : null,
    }
  }

  /**
   * Serve one history request: locally, or forwarded to the publishing peer.
   * @param {Peer} peer - requesting peer.
   * @param {object} message - `history` frame.
   */
  handleHistory(peer, message) {
    peer.lastActiveAt = Date.now()
    const rid = typeof message.rid === 'string' ? message.rid : ''
    // A publisher answering a forwarded request carries `events`; route it back.
    if (Array.isArray(message.events)) {
      this.completeRelay(peer, rid, message.events)
      return
    }
    const relayPeer = typeof message.peer === 'string' ? message.peer : ''
    if (relayPeer !== '') {
      this.forwardHistory(peer, relayPeer, rid, message)
      return
    }
    peer.historyReads += 1
    peer.lastHistoryAt = Date.now()
    const sessionId = String(message.session ?? '')
    const summary = this.sessions.get(sessionId)
    if (!summary || !peer.canSee(summary)) {
      peer.send({ t: 'error', rid, code: 'forbidden', message: '该会话不可见' })
      return
    }
    const max = SessionInventory.pageSize(message.max, this.config.maxHistory)
    const after = Number.isFinite(Number(message.after)) ? Math.max(0, Math.floor(Number(message.after))) : undefined
    this.inventory
      .readEvents(sessionId, max, after)
      .then((events) => {
        peer.send({ t: 'history', rid, session: sessionId, events, hasMore: false, at: Date.now() })
      })
      .catch((error) => {
        peer.send({ t: 'error', rid, code: 'history-failed', message: String(error?.message ?? error) })
      })
  }

  /**
   * Forward one consumer request to the publishing peer.
   * @param {Peer} consumer - asking peer.
   * @param {string} publisherId - publisher peer id.
   * @param {string} rid - consumer request id.
   * @param {object} message - original frame.
   */
  forwardHistory(consumer, publisherId, rid, message) {
    const reply = (code, text) => consumer.send({ t: 'error', rid, code, message: text })
    if (!this.relayEnabled) {
      reply('relay-disabled', '服务端未开启 server.relay.enabled')
      return
    }
    if (!consumer.subscribes) {
      reply('relay-unsupported', '握手未协商 relay.subscribe 能力')
      return
    }
    const publisher = [...this.peers].find((peer) => peer.id === publisherId)
    if (publisher === undefined || !publisher.welcomed || publisher.dead) {
      reply('relay-offline', '被转发的机器已断开')
      return
    }
    const sessionId = String(message.session ?? '')
    if (!publisher.published.has(sessionId)) {
      reply('forbidden', '该会话未被共享')
      return
    }
    if (!shareAllowsConsumer(publisher.share, consumer.grant.name)) {
      reply('forbidden', '共享方没有授权给本机')
      return
    }
    const relayRid = `relay-${++nextRelayId}`
    const max = SessionInventory.pageSize(message.max, this.config.maxHistory)
    const after = Number.isFinite(Number(message.after)) ? Math.max(0, Math.floor(Number(message.after))) : undefined
    const timer = setTimeout(() => {
      this.relayPending.delete(relayRid)
      consumer.send({ t: 'error', rid, code: 'relay-timeout', message: '转发请求超时' })
    }, RELAY_TIMEOUT_MS)
    timer.unref?.()
    this.relayPending.set(relayRid, { peer: consumer, rid, publisherId, timer })
    publisher.relayServed += 1
    publisher.lastHistoryAt = Date.now()
    publisher.send({ t: 'history', rid: relayRid, session: sessionId, after, max })
  }

  /**
   * Relay a publisher's answer back to the consumer that asked.
   * @param {Peer} publisher - answering peer.
   * @param {string} relayRid - forwarded request id.
   * @param {object[]} events - remote events.
   */
  completeRelay(publisher, relayRid, events) {
    const pending = this.relayPending.get(relayRid)
    if (pending === undefined) return
    this.relayPending.delete(relayRid)
    clearTimeout(pending.timer)
    if (pending.publisherId !== publisher.id) return
    pending.peer.send({
      t: 'history',
      rid: pending.rid,
      peer: publisher.id,
      events,
      hasMore: false,
      at: Date.now(),
    })
  }

  /** Re-read the Host session list and push it to peers when it changed. */
  async refresh() {
    if (this.stopped || this.peers.size === 0) return
    if (this.refreshing !== null) return this.refreshing
    const controller = new AbortController()
    this.refreshing = (async () => {
      try {
        const list = await this.inventory.list(controller.signal)
        this.inventory.diag.records = list.length
        const next = new Map()
        for (const wire of list.slice(0, MAX_LISTED_SESSIONS)) next.set(wire.id, wire)
        this.inventory.diag.mapped = next.size
        this.sessions = next
        this.lastError = null
        const key = JSON.stringify([...next.values()].map((item) => [item.id, item.updatedAt, item.title, item.running]))
        if (key === this.lastListKey) return
        this.lastListKey = key
        this.pushSessions()
      } catch (error) {
        this.lastError = String(error?.stack ?? error)
        this.log?.warn?.(`远程桥接会话列表读取失败：${String(error?.message ?? error)}`)
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /** Push the current filtered list to every welcomed peer. */
  pushSessions() {
    const ordered = [...this.sessions.values()].sort((left, right) => right.updatedAt - left.updatedAt)
    for (const peer of this.peers) {
      if (!peer.welcomed || peer.dead) continue
      peer.send({ t: 'sessions', sessions: ordered.filter((summary) => peer.canSee(summary)), at: Date.now() })
    }
  }

  /**
   * Fan out one committed session event.
   * @param {{ id: string, header?: { cwd?: string } }} session - appended session.
   * @param {object} event - committed event.
   */
  broadcastEvent(session, event) {
    if (this.peers.size === 0) return
    const id = String(session.id)
    const summary = this.sessions.get(id) ?? { id, cwd: session.header?.cwd ?? null }
    let frame = null
    for (const peer of this.peers) {
      if (!peer.welcomed || peer.dead) continue
      if (!peer.canSee(summary)) continue
      frame ??= { t: 'event', session: id, event }
      peer.send(frame)
    }
  }
}
