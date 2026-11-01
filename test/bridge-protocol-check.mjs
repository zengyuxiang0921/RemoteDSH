import { readFileSync } from 'node:fs'

const target = process.argv[2] ?? 'ws://127.0.0.1:4590/ws'
const client = new WebSocket(target)

const waiters = new Map()
const inbox = []
let nextRid = 0

function waitFor(type, timeout = 8000) {
  const existing = inbox.find((message) => message.t === type)
  if (existing) {
    inbox.splice(inbox.indexOf(existing), 1)
    return Promise.resolve(existing)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout)
    waiters.set(type, (message) => {
      clearTimeout(timer)
      waiters.delete(type)
      resolve(message)
    })
  })
}

client.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.t === 'ping') return
  const waiter = waiters.get(message.t)
  if (waiter) waiter(message)
  else inbox.push(message)
})

await new Promise((resolve, reject) => {
  client.addEventListener('open', resolve, { once: true })
  client.addEventListener('error', (error) => reject(new Error(String(error?.message ?? error))), { once: true })
})
client.send(JSON.stringify({ t: 'hello', v: 1, client: { name: 'smoke-test' }, auth: {} }))

const welcome = await waitFor('welcome')
console.log('welcome:', JSON.stringify({ server: welcome.server, you: welcome.you, sessions: welcome.sessions.length }))
if (welcome.sessions.length === 0) {
  console.log('no sessions to read')
  client.close()
  process.exit(0)
}
const target1 = welcome.sessions.find((session) => session.origin !== 'subagent') ?? welcome.sessions[0]
console.log('first session:', JSON.stringify({ id: target1.id, title: target1.title, updatedAt: target1.updatedAt, cwd: target1.cwd }))

const rid = `r${++nextRid}`
client.send(JSON.stringify({ t: 'history', rid, session: target1.id, max: 500 }))
const history = await waitFor('history')
const events = history.events ?? []
console.log('history events:', events.length, 'first types:', events.slice(0, 5).map((event) => event.type).join(','))

const userEvent = events.find((event) => event.type === 'user/message')
if (userEvent) {
  const text = (userEvent.data?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
  console.log('first user text:', JSON.stringify(text.slice(0, 80)))
}
client.close()
console.log('protocol smoke test ok')
process.exit(0)
