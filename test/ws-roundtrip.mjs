import http from 'node:http'
import assert from 'node:assert/strict'
import { ServerSocket, isWebSocketUpgrade } from '../lib/ws.js'

const server = http.createServer((_req, res) => res.end('ok'))
server.on('upgrade', (req, socket, head) => {
  if (!isWebSocketUpgrade(req)) return socket.destroy()
  const ws = ServerSocket.accept(req, socket, head, {
    maxPayload: 4 * 1024 * 1024,
    onMessage: (text) => {
      const message = JSON.parse(text)
      ws.send({ t: 'echo', length: message.payload?.length ?? 0, same: message.payload ?? null })
    },
    onClose: () => {},
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const received = []
const client = new WebSocket(`ws://127.0.0.1:${port}/ws`)
await new Promise((resolve, reject) => {
  client.addEventListener('open', resolve, { once: true })
  client.addEventListener('error', reject, { once: true })
})

const waitFor = (count) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      if (received.length >= count) return resolve()
      if (Date.now() - started > 5000) return reject(new Error('timeout'))
      setTimeout(poll, 20)
    }
    poll()
  })

client.addEventListener('message', (event) => {
  received.push(JSON.parse(event.data))
})

client.send(JSON.stringify({ t: 'hello', payload: 'hi' }))
await waitFor(1)
assert.equal(received[0].t, 'echo')
assert.equal(received[0].length, 2)

const big = 'x'.repeat(200 * 1024)
client.send(JSON.stringify({ t: 'hello', payload: big }))
await waitFor(2)
assert.equal(received[1].length, big.length)

// Two messages in one tick must both arrive intact.
client.send(JSON.stringify({ t: 'a', payload: '1' }))
client.send(JSON.stringify({ t: 'b', payload: '22' }))
await waitFor(4)
assert.equal(received[2].length, 1)
assert.equal(received[3].length, 2)

client.close()
await new Promise((resolve) => setTimeout(resolve, 50))
server.close()
console.log('ws roundtrip ok:', received.length, 'frames')
process.exit(0)
