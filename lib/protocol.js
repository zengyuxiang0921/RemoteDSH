/** Shared configuration and protocol helpers for remote-bridge. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'

export const PLUGIN_VERSION = '0.1.0'
export const PROTOCOL_VERSION = 1

const MODES = new Set(['server', 'client', 'both', 'off'])

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

/**
 * Normalize the user's patch config into one predictable shape.
 * @param {unknown} raw - the loader-provided config object.
 * @returns {object} normalized configuration.
 */
export function normalizeConfig(raw) {
  const input = plainObject(raw)
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
  }
  if (mode === 'client' || mode === 'off') server.enabled = false

  const clientInput = plainObject(input.client)
  const client = {
    enabled: clientInput.enabled === undefined ? mode === 'client' || mode === 'both' : clientInput.enabled !== false,
    remotes: Array.isArray(clientInput.remotes)
      ? clientInput.remotes.map((item) => normalizeRemote(item)).filter((item) => item !== null)
      : [],
    maxHistory: positiveInt(clientInput.maxHistory, 3000, 20000),
    reconnectMaxMs: positiveInt(clientInput.reconnectMaxMs, 30000, 300000),
  }
  if (mode === 'server' || mode === 'off') client.enabled = false

  return { mode, server, client }
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
