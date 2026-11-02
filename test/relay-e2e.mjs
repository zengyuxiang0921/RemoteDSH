/**
 * End-to-end check of the client-to-client relay: one server, one real
 * `BridgeClient` acting as publisher, one allowed subscriber and one refused
 * subscriber, all over real WebSocket frames.
 *
 * Run: node test/relay-e2e.mjs
 */
import assert from 'node:assert/strict'
import { BridgeServer } from '../lib/server.js'
import { BridgeClient } from '../lib/client.js'
import { PROTOCOL_VERSION } from '../lib/protocol.js'

const silent = { info() {}, warn() {}, debug() {}, error() {} }

/** Sessions the fake Host owns: two ordinary ones and one subagent log. */
const LOGS = {
  'sess-alpha': [
    { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'alpha question' }] } },
    { seq: 1, type: 'assistant/message', data: { content: [] } },
  ],
  'sess-beta': [{ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'beta question' }] } }],
  'sess-child': [{ seq: 0, type: 'user/message', data: { content: [] } }],
}

/** Minimal Host services the inventory and the publisher read. */
function fakeContext() {
  const persistence = {
    async stat(id) {
      const log = LOGS[id]
      return log === undefined ? undefined : { eventCount: log.length }
    },
    async open(id) {
      const log = LOGS[id] ?? []
      return {
        async read(from) {
          return { events: log.slice(Math.max(0, from)) }
        },
        async close() {},
      }
    },
  }
  const query = {
    async listSessions() {
      return [
        { header: { id: 'sess-alpha', createdAt: 1000, cwd: 'D:\\work\\alpha' } },
        { header: { id: 'sess-beta', createdAt: 2000, cwd: 'D:\\work\\beta' } },
        { header: { id: 'sess-child', createdAt: 3000, cwd: 'D:\\work\\alpha', origin: 'subagent' } },
      ]
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: `T:${sessionId}` } } }))
    },
  }
  const listeners = []
  return {
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessionQuery') return query
      return undefined
    },
    on(name, listener) {
      if (name === 'session/event') listeners.push(listener)
      return () => {}
    },
    /** Drive the `session/event` fan-out a committed append would produce. */
    emitSessionEvent(session, event) {
      for (const listener of listeners) listener(session, event)
    },
    emit() {},
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
}

/** One raw protocol client, for asserting exactly what crosses the wire. */
class RawPeer {
  constructor(url, name, features, share) {
    this.name = name
    this.inbox = []
    this.ws = new WebSocket(url)
    this.hello = { name, features, share }
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.t !== 'pong') this.inbox.push(message)
    })
  }

  async start() {
    await this.opened
    this.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      client: { name: this.name, version: 'test' },
      auth: { token: 'test-token' },
      features: this.hello.features,
      share: this.hello.share,
    })
    return this.next()
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame))
  }

  async next(match = () => true, timeout = 6000) {
    const deadline = Date.now() + timeout
    for (;;) {
      const found = this.inbox.findIndex(match)
      if (found >= 0) return this.inbox.splice(found, 1)[0]
      if (Date.now() > deadline) throw new Error(`timeout waiting for a frame (${this.name})`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  close() {
    this.ws.close()
  }
}

const ctx = fakeContext()
const server = new BridgeServer(
  ctx,
  {
    host: '127.0.0.1',
    port: 0,
    name: 'relay-hub',
    auth: { token: 'test-token', password: '' },
    allow: { sessions: '*', cwdPrefixes: [] },
    clients: [],
    maxHistory: 500,
    listIntervalMs: 60000,
    relay: { enabled: true, maxRelaySessions: 50 },
  },
  silent,
)
await server.start()
const base = `127.0.0.1:${server.port}`
console.log('hub listening on', base)

// ── publisher: the real client half, sharing only D:\work\alpha ──────────────
const publisher = new BridgeClient(
  ctx,
  {
    enabled: true,
    remotes: [{ id: 'hub', label: '枢纽', url: `http://${base}`, token: 'test-token', password: '' }],
    maxHistory: 500,
    reconnectMaxMs: 1000,
    share: { enabled: true, sessions: '*', cwdPrefixes: ['D:\\work\\alpha'], consumers: ['friend'] },
    relay: { enabled: false },
  },
  silent,
)
publisher.start()

await waitFor(async () => publisher.links[0].status === 'online', 'publisher online')
assert.deepEqual(publisher.links[0].features.sort(), ['history.read', 'relay.publish', 'sessions.read'])
await waitFor(async () => (publisher.links[0].publisher?.advertised.size ?? 0) > 0, 'publisher advertised')
const advertised = [...publisher.links[0].publisher.advertised.keys()].sort()
assert.deepEqual(advertised, ['sess-alpha'], 'only the shared directory is advertised')
console.log('publisher advertises:', advertised.join(', '))

// ── allowed subscriber ──────────────────────────────────────────────────────
const friend = new RawPeer(`ws://${base}/ws`, 'friend', ['sessions.read', 'history.read', 'relay.subscribe'], {})
const friendWelcome = await friend.start()
assert.equal(friendWelcome.t, 'welcome')
assert.equal(friendWelcome.v, PROTOCOL_VERSION)
assert.deepEqual(friendWelcome.features.sort(), ['history.read', 'relay.subscribe', 'sessions.read'])
const relays = friendWelcome.relays
assert.equal(relays.length, 1, 'one publisher relayed')
assert.deepEqual(relays[0].sessions.map((item) => item.id), ['sess-alpha'])
console.log('subscriber sees relayed:', relays[0].peer.name, relays[0].sessions.map((item) => item.id).join(','))

const peerId = relays[0].peer.id
friend.send({ t: 'history', rid: 'q1', peer: peerId, session: 'sess-alpha', after: 0, max: 100 })
const relayed = await friend.next((message) => message.t === 'history' && message.rid === 'q1')
assert.equal(relayed.events.length, LOGS['sess-alpha'].length)
assert.equal(relayed.events[0].type, 'user/message')
assert.equal(relayed.peer, peerId)
console.log('relayed history events:', relayed.events.length)

friend.send({ t: 'history', rid: 'q2', peer: peerId, session: 'sess-beta', after: 0, max: 100 })
const refused = await friend.next((message) => message.t === 'error' && message.rid === 'q2')
assert.equal(refused.code, 'forbidden')
console.log('unshared session refused:', refused.code)

// ── live event of a shared session reaches the subscriber ───────────────────
const liveEvent = { seq: 2, type: 'assistant/message', data: { content: [] } }
ctx.emitSessionEvent({ id: 'sess-alpha' }, liveEvent)
const relayedEvent = await friend.next((message) => message.t === 'relay/event')
assert.equal(relayedEvent.session, 'sess-alpha')
assert.equal(relayedEvent.event.seq, 2)
assert.equal(relayedEvent.peer.id, peerId)
console.log('live relayed event:', relayedEvent.event.type, 'seq', relayedEvent.event.seq)

// An event of a session the publisher does not share stays local.
ctx.emitSessionEvent({ id: 'sess-beta' }, { seq: 1, type: 'assistant/message', data: {} })
await new Promise((resolve) => setTimeout(resolve, 200))
assert.equal(
  friend.inbox.some((message) => message.t === 'relay/event' && message.session === 'sess-beta'),
  false,
  'unshared session events must not be relayed',
)
console.log('unshared session event stayed local')

// ── subscriber the publisher did not name ───────────────────────────────────
const stranger = new RawPeer(`ws://${base}/ws`, 'stranger', ['sessions.read', 'relay.subscribe'], {})
const strangerWelcome = await stranger.start()
assert.equal(strangerWelcome.relays.length, 0, 'no relay for an unauthorised consumer')
stranger.send({ t: 'history', rid: 'q3', peer: peerId, session: 'sess-alpha', after: 0, max: 100 })
const strangerRefused = await stranger.next((message) => message.t === 'error' && message.rid === 'q3')
assert.equal(strangerRefused.code, 'forbidden')
console.log('unauthorised consumer refused:', strangerRefused.code)

// ── a subscriber without the capability gets nothing relayed ────────────────
const plain = new RawPeer(`ws://${base}/ws`, 'friend', ['sessions.read'], {})
const plainWelcome = await plain.start()
assert.deepEqual(plainWelcome.relays, [], 'relay requires the negotiated capability')
console.log('capability gate holds for a bare subscriber')

// ── protocol validation ─────────────────────────────────────────────────────
const stale = new WebSocket(`ws://${base}/ws`)
await new Promise((resolve, reject) => {
  stale.addEventListener('open', resolve, { once: true })
  stale.addEventListener('error', reject, { once: true })
})
const staleReply = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout waiting for protocol refusal')), 5000)
  stale.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.t !== 'pong') {
      clearTimeout(timer)
      resolve(message)
    }
  })
})
stale.send(JSON.stringify({ t: 'hello', v: 99, client: { name: 'ancient' }, auth: { token: 'test-token' } }))
const mismatch = await staleReply
assert.equal(mismatch.t, 'error')
assert.equal(mismatch.code, 'protocol-mismatch')
assert.match(mismatch.message, /relay\.publish/)
console.log('protocol mismatch reported with capabilities:', mismatch.message)

friend.close()
stranger.close()
plain.close()
stale.close()
publisher.stop()
server.stop()
await new Promise((resolve) => setTimeout(resolve, 800))
console.log('relay e2e ok')

/**
 * Poll until a condition holds.
 * @param {() => Promise<boolean> | boolean} check - condition.
 * @param {string} label - failure text.
 */
async function waitFor(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

process.exit(0)
