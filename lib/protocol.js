/** Shared configuration and protocol helpers for remote-bridge. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'

export const PLUGIN_VERSION = '0.5.0'
/** Wire protocol this build speaks. Feature negotiation starts at 2. */
export const PROTOCOL_VERSION = 2
/**
 * Oldest protocol still accepted. A version-1 peer predates feature
 * negotiation, so it negotiates an empty capability set and simply never gets
 * the features that set gates.
 */
export const MIN_PROTOCOL_VERSION = 1

/**
 * Capabilities advertised during the handshake.
 *
 * `sessions.read` and `history.read` describe the always-present baseline and
 * only exist so a peer can reason about a future build that drops one. The
 * relay pair is opt-in on both sides and is what a server must see before it
 * routes one peer's history request to another peer.
 */
export const FEATURES = Object.freeze({
  SESSIONS_READ: 'sessions.read',
  HISTORY_READ: 'history.read',
  RELAY_PUBLISH: 'relay.publish',
  RELAY_SUBSCRIBE: 'relay.subscribe',
})

/** Every capability this build implements. */
export const ALL_FEATURES = Object.freeze(Object.values(FEATURES))

const FEATURE_SET = new Set(ALL_FEATURES)

/**
 * Normalize a capability list from a peer.
 * @param {unknown} value - `features` field of a handshake or welcome.
 * @returns {string[]} known capabilities, de-duplicated and sorted.
 */
export function normalizeFeatures(value) {
  if (!Array.isArray(value)) return []
  const out = new Set()
  for (const item of value) {
    const name = text(item)
    if (FEATURE_SET.has(name)) out.add(name)
  }
  return [...out].sort()
}

/**
 * Capabilities both sides implement.
 * @param {string[]} offered - peer capabilities.
 * @param {string[]} supported - local capabilities.
 * @returns {string[]} negotiated capabilities.
 */
export function negotiateFeatures(offered, supported = ALL_FEATURES) {
  const other = new Set(supported)
  return offered.filter((name) => other.has(name))
}

/**
 * Whether a handshake reports a protocol this build can speak.
 * @param {unknown} version - `v` field of a hello frame.
 * @returns {boolean} acceptance.
 */
export function isSupportedProtocol(version) {
  const v = Number(version)
  return Number.isInteger(v) && v >= MIN_PROTOCOL_VERSION && v <= PROTOCOL_VERSION
}

const MODES = new Set(['server', 'client', 'both', 'off'])

/** Protocol symbol cosmokit uses for configuration references, across ESM/CJS copies. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Whether a parsed config value is a volatile reference rather than plain data.
 * @param {unknown} value - parsed config node.
 * @returns {boolean} true for a cosmokit reference.
 */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * Resolve volatile references into detached plain data.
 *
 * A schema field marked `.volatile()` parses to a stable reference object, not
 * to the configured value, so every reader must dereference it before looking
 * inside. Skipping this step silently degrades every option to its default.
 * @param {unknown} value - parsed config node.
 * @returns {unknown} plain configuration data.
 */
export function unwrapConfig(value) {
  if (isVolatileRef(value)) return unwrapConfig(value.get())
  if (Array.isArray(value)) return value.map(unwrapConfig)
  if (value !== null && typeof value === 'object') {
    if (typeof Reflect.get(value, '__jsExpr') === 'string') return value
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = unwrapConfig(child)
    return out
  }
  return value
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInt(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map(text).filter((item) => item !== '')
}

/** Normalize a list of non-empty trimmed strings. */
export const normalizeStrings = stringList

/**
 * Normalize the user's patch config into one predictable shape.
 * @param {unknown} raw - the loader-provided config object.
 * @returns {object} normalized configuration.
 */
export function normalizeConfig(raw) {
  const input = plainObject(unwrapConfig(raw))
  const mode = MODES.has(text(input.mode)) ? text(input.mode) : 'both'

  const serverInput = plainObject(input.server)
  const server = {
    enabled: serverInput.enabled === undefined ? mode === 'server' || mode === 'both' : serverInput.enabled !== false,
    host: text(serverInput.host) || '0.0.0.0',
    port: positiveInt(serverInput.port, 4590, 65535),
    name: text(serverInput.name) || hostname(),
    auth: {
      token: text(plainObject(serverInput.auth).token),
      password: text(plainObject(serverInput.auth).password),
    },
    allow: {
      sessions: normalizeScope(plainObject(serverInput.allow).sessions),
      cwdPrefixes: stringList(plainObject(serverInput.allow).cwdPrefixes),
    },
    clients: Array.isArray(serverInput.clients)
      ? serverInput.clients.map((item) => normalizeClientGrant(item)).filter((item) => item !== null)
      : [],
    maxHistory: positiveInt(serverInput.maxHistory, 2000, 20000),
    listIntervalMs: positiveInt(serverInput.listIntervalMs, 5000, 60000),
    relay: {
      enabled: plainObject(serverInput.relay).enabled === true,
      maxRelaySessions: positiveInt(plainObject(serverInput.relay).maxRelaySessions, 200, 1000),
    },
  }
  if (mode === 'client' || mode === 'off') server.enabled = false

  const clientInput = plainObject(input.client)
  const shareInput = plainObject(clientInput.share)
  const client = {
    enabled: clientInput.enabled === undefined ? mode === 'client' || mode === 'both' : clientInput.enabled !== false,
    remotes: Array.isArray(clientInput.remotes)
      ? clientInput.remotes.map((item) => normalizeRemote(item)).filter((item) => item !== null)
      : [],
    maxHistory: positiveInt(clientInput.maxHistory, 3000, 20000),
    reconnectMaxMs: positiveInt(clientInput.reconnectMaxMs, 30000, 300000),
    share: {
      enabled: shareInput.enabled === true,
      sessions: normalizeScope(shareInput.sessions),
      cwdPrefixes: stringList(shareInput.cwdPrefixes),
      consumers: stringList(shareInput.consumers),
    },
    relay: {
      enabled: plainObject(clientInput.relay).enabled === true,
    },
  }
  if (mode === 'server' || mode === 'off') client.enabled = false

  return { mode, server, client }
}

/**
 * Normalize a peer's share intent from a handshake or publish frame.
 * @param {unknown} value - `share` field.
 * @returns {{ enabled: boolean, sessions: string, cwdPrefixes: string[], consumers: string[] }} intent.
 */
export function normalizeShare(value) {
  const input = plainObject(value)
  return {
    enabled: input.enabled === true,
    sessions: normalizeScope(input.sessions),
    cwdPrefixes: stringList(input.cwdPrefixes),
    consumers: stringList(input.consumers),
  }
}

/**
 * Whether a publisher shares with one admitted consumer.
 * @param {{ consumers: string[] }} share - publisher intent.
 * @param {string} consumerName - admitted identity of the asking peer.
 * @returns {boolean} permission; an empty list means "any admitted peer".
 */
export function shareAllowsConsumer(share, consumerName) {
  const consumers = Array.isArray(share?.consumers) ? share.consumers : []
  if (consumers.length === 0) return true
  const name = text(consumerName).toLowerCase()
  if (name === '') return false
  return consumers.some((entry) => entry.toLowerCase() === name)
}

/**
 * Whether one published session may be relayed.
 * @param {{ sessions: string, cwdPrefixes: string[] }} share - publisher scope.
 * @param {object} summary - wire session summary.
 * @returns {boolean} visibility.
 */
export function shareAllowsSession(share, summary) {
  if (!summary || summary.origin === 'subagent') return false
  const id = String(summary.id ?? '')
  if (id === '') return false
  // A mirrored session is another machine's record; relaying it would leak a
  // third machine's history past every grant it passed on the way here.
  if (id.startsWith('session-rb-')) return false
  return allowsSession({ sessions: share.sessions, cwdPrefixes: share.cwdPrefixes }, summary)
}

function normalizeScope(value) {
  const scope = text(value)
  if (scope === '') return '*'
  return scope
}

function normalizeClientGrant(item) {
  const input = plainObject(item)
  const token = text(input.token)
  const password = text(input.password)
  if (token === '' && password === '') return null
  return {
    name: text(input.name) || 'client',
    token,
    password,
    allow: {
      sessions: normalizeScope(plainObject(input.allow).sessions),
      cwdPrefixes: stringList(plainObject(input.allow).cwdPrefixes),
    },
  }
}

/**
 * Normalize one remote link entry.
 * @param {unknown} item - one `client.remotes` entry.
 * @returns {object | null} normalized link, or null when it has no URL.
 */
export function normalizeRemote(item) {
  const input = plainObject(item)
  const url = text(input.url)
  if (url === '') return null
  const label = text(input.label)
  const id = text(input.id) || label || url
  return {
    id,
    label: label || id,
    url,
    token: text(input.token),
    password: text(input.password),
  }
}

/**
 * Turn `http(s)://host:port`, `ws(s)://host:port` or `host:port` into a WebSocket URL.
 * @param {string} input - configured base URL.
 * @returns {string} absolute ws/wss URL.
 */
export function normalizeWsUrl(input) {
  let value = text(input)
  if (value === '') throw new Error('empty remote url')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`
  const url = new URL(value)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`unsupported protocol: ${url.protocol}`)
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws'
  return url.toString()
}

/**
 * Compare two secrets without leaking their length or content through timing.
 * @param {unknown} left - provided value.
 * @param {unknown} right - expected value.
 * @returns {boolean} whether both are equal non-empty strings.
 */
export function safeEqual(left, right) {
  const a = typeof left === 'string' ? left : ''
  const b = typeof right === 'string' ? right : ''
  if (a === '' || b === '') return false
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Whether a session is inside a granted scope.
 * @param {{ sessions: string, cwdPrefixes: readonly string[] }} allow - grant scope.
 * @param {{ id: string, cwd?: string | null }} session - candidate session.
 * @returns {boolean} visibility.
 */
export function allowsSession(allow, session) {
  if (!allow) return false
  const scope = allow.sessions
  if (scope !== '*' && scope !== 'all') {
    const ids = String(scope).split(',').map((item) => item.trim()).filter(Boolean)
    if (!ids.includes(session.id)) return false
  }
  const prefixes = Array.isArray(allow.cwdPrefixes) ? allow.cwdPrefixes : []
  if (prefixes.length > 0) {
    const cwd = typeof session.cwd === 'string' ? session.cwd : ''
    if (cwd === '') return false
    const normalized = cwd.replace(/\\/g, '/').toLowerCase()
    const inside = prefixes.some((prefix) => normalized.startsWith(prefix.replace(/\\/g, '/').toLowerCase()))
    if (!inside) return false
  }
  return true
}

/**
 * Convert one Host `SessionSummary` into the wire shape shared by both modes.
 * @param {object} summary - `ctx.sessionController.list()` row.
 * @returns {object} wire session summary.
 */
export function wireSummary(summary) {
  const title = summary?.projections?.values?.title
  return {
    id: String(summary.sessionId),
    title: typeof title === 'string' && title !== '' ? title : null,
    updatedAt: Number(summary.updatedAt) || 0,
    running: summary.running === true,
    blank: summary.blank === true,
    cwd: typeof summary.cwd === 'string' ? summary.cwd : null,
    parentId: summary.parentSessionId ? String(summary.parentSessionId) : null,
    origin: summary.origin === 'subagent' ? 'subagent' : null,
  }
}
