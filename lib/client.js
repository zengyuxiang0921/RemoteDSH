/**
 * Client mode: connect to remote DSH bridge servers and mirror their session
 * records into this Host as ordinary local Sessions.
 *
 * Two independent roles ride on the same WebSocket:
 *
 * - subscriber: mirror the server's own sessions, plus the sessions other
 *   clients share through the server (`client.relay.enabled`).
 * - publisher: advertise a scoped subset of this Host's sessions so other
 *   clients can read them through the server (`client.share.enabled`).
 *
 * Both roles are capability-gated: the handshake reports what each side
 * supports and only the intersection is used.
 */
import { hostname } from 'node:os'
import {
  ALL_FEATURES,
  FEATURES,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  isSupportedProtocol,
  negotiateFeatures,
  normalizeStrings,
  normalizeWsUrl,
} from './protocol.js'
import { RemoteMirror } from './mirror.js'
import { SessionPublisher } from './publisher.js'

const WELCOME_TIMEOUT_MS = 12000
const HEARTBEAT_MS = 20000
const REQUEST_TIMEOUT_MS = 20000

/** One remote DSH connection. */
export class RemoteLink {
  /**
   * @param {BridgeClient} owner - owning hub.
   * @param {object} config - normalized remote entry.
   * @param {object} log - Cordis logger.
   */
  constructor(owner, config, log) {
    this.owner = owner
    this.config = config
    this.log = log
    this.status = 'idle'
    this.error = null
    this.serverName = null
    this.connectedAt = null
    this.lastActiveAt = null
    this.sessions = []
    this.serverFeatures = []
    this.features = []
    this.peerId = null
    this.relays = new Map()
    this.publisher = null
    this.ws = null
    this.stopped = false
    this.attempt = 0
    this.retryTimer = null
    this.heartbeat = null
    this.welcomeTimer = null
    this.rid = 0
    this.pending = new Map()
    this.url = null
    try {
      this.url = normalizeWsUrl(config.url)
    } catch (error) {
      this.status = 'error'
      this.error = String(error?.message ?? error)
    }
  }

  /** @returns {string[]} capabilities this link will ask for. */
  offeredFeatures() {
    const share = this.owner.config.share
    const relay = this.owner.config.relay
    const out = [FEATURES.SESSIONS_READ, FEATURES.HISTORY_READ]
    if (share?.enabled === true) out.push(FEATURES.RELAY_PUBLISH)
    if (relay?.enabled === true) out.push(FEATURES.RELAY_SUBSCRIBE)
    return out
  }

  /** @returns {object} the share intent reported to the server. */
  shareIntent() {
    const share = this.owner.config.share ?? {}
    return {
      enabled: share.enabled === true,
      sessions: share.sessions ?? '*',
      cwdPrefixes: normalizeStrings(share.cwdPrefixes),
      consumers: normalizeStrings(share.consumers),
    }
  }

  /** Open the link, retrying with exponential backoff. */
  connect() {
    if (this.stopped || this.url === null) return
    this.clearRetry()
    this.status = 'connecting'
    let socket
    try {
      socket = new WebSocket(this.url)
    } catch (error) {
      this.error = String(error?.message ?? error)
      this.log?.warn?.(`远程桥接：无法建立 WebSocket（${this.config.label}）：${this.error}`)
      this.scheduleReconnect()
      return
    }
    this.ws = socket
    socket.addEventListener('open', () => {
      try {
        socket.send(
          JSON.stringify({
            t: 'hello',
            v: PROTOCOL_VERSION,
            client: { name: hostname(), version: PLUGIN_VERSION },
            auth: { token: this.config.token, password: this.config.password },
            features: this.offeredFeatures(),
            share: this.shareIntent(),
          }),
        )
      } catch {
        // the close handler owns recovery
      }
      this.welcomeTimer = setTimeout(() => {
        if (this.status !== 'online') {
          this.error = '服务端握手超时'
          try {
            socket.close()
          } catch {
            // ignore
          }
        }
      }, WELCOME_TIMEOUT_MS)
      this.welcomeTimer.unref?.()
      this.heartbeat = setInterval(() => {
        try {
          socket.send(JSON.stringify({ t: 'ping' }))
        } catch {
          // ignore
        }
      }, HEARTBEAT_MS)
      this.heartbeat.unref?.()
    })
    socket.addEventListener('message', (event) => this.handleMessage(event.data))
    socket.addEventListener('close', () => {
      this.cleanupSocket()
      this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      this.log?.warn?.(`远程桥接：连接 ${this.config.label} 出错（${this.url}）`)
    })
  }

  /**
   * Send one frame if the socket is usable.
   * @param {object} frame - protocol frame.
   */
  send(frame) {
    if (this.ws === null) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      // a close handler owns recovery
    }
  }

  /** Stop for good. */
  dispose() {
    this.stopped = true
    this.clearRetry()
    this.cleanupSocket()
    this.rejectPending('remote link disposed')
    this.publisher?.stop()
    this.publisher = null
    this.relays.clear()
  }

  clearRetry() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  cleanupSocket() {
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer)
    this.heartbeat = null
    this.welcomeTimer = null
    this.ws = null
    this.peerId = null
    this.serverFeatures = []
    this.features = []
    this.relays.clear()
    this.publisher?.stop()
  }

  /** Schedule the next connection attempt. */
  scheduleReconnect() {
    if (this.stopped || this.status === 'denied') return
    this.status = 'offline'
    this.attempt = Math.min(this.attempt + 1, 34)
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt - 1, 5), this.owner.config.reconnectMaxMs)
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
    this.retryTimer.unref?.()
  }

  /** @param {string} feature - capability name. @returns {boolean} negotiated. */
  has(feature) {
    return this.features.includes(feature)
  }

  /**
   * @param {string | ArrayBuffer} raw - WebSocket payload.
   */
  handleMessage(raw) {
    if (typeof raw !== 'string') return
    this.lastActiveAt = Date.now()
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    switch (message.t) {
      case 'welcome': {
        if (!isSupportedProtocol(message.v)) {
          this.error = `协议版本不兼容：服务端 v${String(message.v)}，本端 ${PROTOCOL_VERSION}`
          this.status = 'denied'
          this.log?.warn?.(`远程桥接（${this.config.label}）：${this.error}`)
          return
        }
        this.serverName = typeof message.server?.name === 'string' ? message.server.name : this.config.label
        this.peerId = typeof message.you?.id === 'string' ? message.you.id : null
        this.serverFeatures = normalizeFeaturesSafe(message.featuresSupported)
        this.features = negotiateFeatures(normalizeFeaturesSafe(message.features), ALL_FEATURES)
        this.error = null
        this.attempt = 0
        this.clearRetry()
        if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer)
        this.welcomeTimer = null
        this.status = 'online'
        this.connectedAt = Date.now()
        this.sessions = Array.isArray(message.sessions) ? message.sessions : []
        this.log?.info?.(
          `已连接远程 DSH「${this.config.label}」（${this.serverName}），会话 ${this.sessions.length} 个；` +
            `能力：${this.features.join(', ') || '仅基础'}`,
        )
        this.owner.onSessions(this, this.sessions)
        this.owner.onWelcome(this, message)
        return
      }
      case 'sessions':
        this.sessions = Array.isArray(message.sessions) ? message.sessions : []
        this.owner.onSessions(this, this.sessions)
        return
      case 'event':
        this.owner.onEvent(this, String(message.session ?? ''), message.event)
        return
      case 'relay/sessions': {
        const peer = message.peer
        if (peer === null || typeof peer !== 'object') return
        this.owner.onRelaySessions(this, peer, message.sessions, message.gone === true)
        return
      }
      case 'relay/event': {
        const peer = message.peer
        if (peer === null || typeof peer !== 'object') return
        this.owner.onRelayEvent(this, peer, String(message.session ?? ''), message.event)
        return
      }
      case 'history': {
        const rid = String(message.rid ?? '')
        if (Array.isArray(message.events)) {
          const pending = this.pending.get(rid)
          if (pending === undefined) return
          this.pending.delete(rid)
          pending.resolve(message.events)
          return
        }
        // No payload: the server is forwarding another client's request here.
        const sessionId = String(message.session ?? '')
        if (this.publisher === null || sessionId === '') return
        const after = Number.isFinite(Number(message.after)) ? Math.max(0, Math.floor(Number(message.after))) : undefined
        const max = Number(message.max) > 0 ? Math.floor(Number(message.max)) : 2000
        this.publisher.answer(rid, sessionId, after, max)
        return
      }
      case 'error': {
        const rid = String(message.rid ?? '')
        if (rid !== '') {
          const pending = this.pending.get(rid)
          if (pending !== undefined) {
            this.pending.delete(rid)
            pending.reject(new Error(String(message.message ?? message.code ?? 'remote error')))
          }
          return
        }
        if (message.code === 'auth-failed' || message.code === 'protocol-mismatch') {
          this.error = String(message.message ?? '鉴权失败')
          this.status = 'denied'
          this.rejectPending(this.error)
          try {
            this.ws?.close()
          } catch {
            // ignore
          }
          this.log?.warn?.(`远程桥接（${this.config.label}）：${this.error}`)
          return
        }
        this.error = String(message.message ?? message.code ?? 'remote error')
        this.log?.warn?.(`远程桥接（${this.config.label}）错误：${this.error}`)
        return
      }
      case 'pong':
        return
      default:
        return
    }
  }

  /**
   * Read one history slice from the remote log.
   * @param {string} sessionId - remote session id.
   * @param {number} after - exclusive lower bound; `0` reads from the beginning.
   * @param {number} max - event budget.
   * @param {string} [peerId] - publisher peer id for a relayed session.
   * @returns {Promise<object[]>} events in seq order.
   */
  async fetchHistory(sessionId, after, max, peerId) {
    if (this.ws === null || this.status !== 'online') {
      throw new Error(`远程连接不可用（${this.status}）`)
    }
    const rid = `h${++this.rid}`
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new Error('远程历史读取超时'))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(rid, {
        resolve: (events) => {
          clearTimeout(timer)
          resolve(events)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      const frame = { t: 'history', rid, session: sessionId, after, max }
      if (typeof peerId === 'string' && peerId !== '') frame.peer = peerId
      try {
        this.ws.send(JSON.stringify(frame))
      } catch (error) {
        this.pending.delete(rid)
        clearTimeout(timer)
        reject(error)
      }
    })
    return promise
  }

  /**
   * @param {string} reason - rejection text for in-flight requests.
   */
  rejectPending(reason) {
    for (const [rid, pending] of this.pending) {
      pending.reject(new Error(reason))
      this.pending.delete(rid)
    }
  }
}

/**
 * Capability list that tolerates a malformed field from a peer.
 * @param {unknown} value - wire field.
 * @returns {string[]} capability names.
 */
function normalizeFeaturesSafe(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/**
 * A mirror channel for one relayed peer, shaped like a RemoteLink so
 * `RemoteMirror` needs no relay-specific branch.
 * @param {RemoteLink} link - carrier of the relayed peer.
 * @param {{ id: string, name?: string }} peer - publisher identity.
 * @returns {object} channel facade.
 */
function relayChannel(link, peer) {
  const name = typeof peer.name === 'string' && peer.name !== '' ? peer.name : peer.id
  return {
    config: { id: `${link.config.id}#${peer.id}`, label: `${name} · 经 ${link.config.label}` },
    get serverName() {
      return link.serverName
    },
    get status() {
      return link.status
    },
    fetchHistory: (sessionId, after, max) => link.fetchHistory(sessionId, after, max, peer.id),
  }
}

/** The client-side hub: one link and one mirror per configured remote. */
export class BridgeClient {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {object} config - normalized `client` config.
   * @param {object} log - Cordis logger.
   */
  constructor(ctx, config, log) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.links = config.remotes.map((remote) => new RemoteLink(this, remote, log))
    this.mirrors = new Map(this.links.map((link) => [link.config.id, new RemoteMirror(ctx, link, log)]))
    /** @type {Map<string, RemoteMirror>} relay channels, keyed `<linkId>#<peerId>`. */
    this.relayMirrors = new Map()
    this.offEvent = null
    this.started = false
  }

  /** Live outbound-link metadata for the management panel. */
  snapshot() {
    return {
      enabled: true,
      share: {
        enabled: this.config.share?.enabled === true,
        sessions: this.config.share?.sessions ?? '*',
        cwdPrefixes: [...(this.config.share?.cwdPrefixes ?? [])],
        consumers: [...(this.config.share?.consumers ?? [])],
      },
      relay: { enabled: this.config.relay?.enabled === true },
      links: this.links.map((link) => ({
        id: link.config.id,
        label: link.config.label,
        url: link.url ?? link.config.url,
        status: link.status,
        error: link.error,
        serverName: link.serverName,
        connectedAt: link.connectedAt,
        lastActiveAt: link.lastActiveAt,
        sessions: link.sessions.length,
        attempt: link.attempt,
        features: [...link.features],
        serverFeatures: [...link.serverFeatures],
        publishing: link.publisher?.advertised.size ?? 0,
        relays: [...link.relays.values()].map((entry) => ({
          peerId: entry.peer.id,
          name: entry.peer.name ?? entry.peer.id,
          sessions: entry.sessions.length,
        })),
      })),
    }
  }

  /** Connect every configured remote. */
  start() {
    if (this.started) return
    this.started = true
    if (this.config.share?.enabled === true) {
      this.offEvent = this.ctx.on('session/event', (session, event) => {
        for (const link of this.links) link.publisher?.forwardEvent(session, event)
      })
    }
    for (const link of this.links) link.connect()
  }

  /** Disconnect and release every mirror writer. */
  stop() {
    this.started = false
    try {
      this.offEvent?.()
    } catch {
      // ignore
    }
    this.offEvent = null
    for (const link of this.links) link.dispose()
    for (const mirror of this.mirrors.values()) {
      mirror.dispose().catch(() => {})
    }
    for (const mirror of this.relayMirrors.values()) {
      mirror.dispose().catch(() => {})
    }
    this.relayMirrors.clear()
  }

  /**
   * @param {RemoteLink} link - link that published its session list.
   * @param {object[]} sessions - remote session summaries.
   */
  onSessions(link, sessions) {
    const mirror = this.mirrors.get(link.config.id)
    if (mirror === undefined) return
    mirror.sync(sessions).catch((error) => {
      this.log?.warn?.(`同步远程「${link.config.label}」会话失败：${String(error?.message ?? error)}`)
    })
  }

  /**
   * Apply the negotiated capabilities of one freshly welcomed link.
   * @param {RemoteLink} link - welcomed link.
   * @param {object} message - welcome frame.
   */
  onWelcome(link, message) {
    const relays = Array.isArray(message.relays) ? message.relays : []
    link.relays.clear()
    for (const entry of relays) {
      if (entry === null || typeof entry !== 'object' || entry.peer === null || typeof entry.peer !== 'object') continue
      this.syncRelay(link, entry.peer, Array.isArray(entry.sessions) ? entry.sessions : [])
    }
    if (link.has(FEATURES.RELAY_PUBLISH)) {
      link.publisher ??= new SessionPublisher(this.ctx, link, this.config.share, this.log)
      link.publisher.start()
    }
    if (this.config.share?.enabled === true && !link.has(FEATURES.RELAY_PUBLISH)) {
      this.log?.info?.(`服务端「${link.serverName}」未协商 relay.publish，本机会话不会被共享`)
    }
    if (this.config.relay?.enabled === true && !link.has(FEATURES.RELAY_SUBSCRIBE)) {
      this.log?.info?.(`服务端「${link.serverName}」未协商 relay.subscribe，或未开启 server.relay.enabled`)
    }
  }

  /**
   * Update the mirror of one relayed peer.
   * @param {RemoteLink} link - carrier.
   * @param {{ id: string, name?: string }} peer - publisher identity.
   * @param {object[]} sessions - published summaries.
   * @param {boolean} [gone] - the publisher left.
   */
  onRelaySessions(link, peer, sessions, gone) {
    if (gone === true) {
      const key = `${link.config.id}#${peer.id}`
      const mirror = this.relayMirrors.get(key)
      this.relayMirrors.delete(key)
      link.relays.delete(key)
      mirror?.dispose().catch(() => {})
      return
    }
    this.syncRelay(link, peer, sessions)
  }

  /**
   * Reconcile one relayed peer's mirror with its published list.
   * @param {RemoteLink} link - carrier.
   * @param {{ id: string, name?: string }} peer - publisher identity.
   * @param {object[]} sessions - published summaries.
   */
  syncRelay(link, peer, sessions) {
    if (this.config.relay?.enabled !== true || !link.has(FEATURES.RELAY_SUBSCRIBE)) return
    const key = `${link.config.id}#${peer.id}`
    let mirror = this.relayMirrors.get(key)
    if (mirror === undefined) {
      mirror = new RemoteMirror(this.ctx, relayChannel(link, peer), this.log)
      this.relayMirrors.set(key, mirror)
    }
    link.relays.set(key, { peer, sessions })
    mirror.sync(sessions).catch((error) => {
      this.log?.warn?.(`同步转发会话（${peer.name ?? peer.id}）失败：${String(error?.message ?? error)}`)
    })
  }

  /**
   * @param {RemoteLink} link - link that received the event.
   * @param {string} sessionId - remote session id.
   * @param {object} event - committed remote event.
   */
  onEvent(link, sessionId, event) {
    const mirror = this.mirrors.get(link.config.id)
    if (mirror === undefined || sessionId === '' || event === null || typeof event !== 'object') return
    mirror.onEvent(sessionId, event).catch(() => {})
  }

  /**
   * @param {RemoteLink} link - carrier.
   * @param {{ id: string }} peer - publisher identity.
   * @param {string} sessionId - published session id.
   * @param {object} event - committed remote event.
   */
  onRelayEvent(link, peer, sessionId, event) {
    if (sessionId === '' || event === null || typeof event !== 'object') return
    const mirror = this.relayMirrors.get(`${link.config.id}#${peer.id}`)
    if (mirror === undefined) return
    mirror.onEvent(sessionId, event).catch(() => {})
  }
}
