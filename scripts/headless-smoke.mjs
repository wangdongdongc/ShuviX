#!/usr/bin/env node
/**
 * Smoke check for a running ShuviX headless instance (docs/headless/design.md §3), over its network access only —
 * the same way a browser on the LAN uses it. Run from a checkout after `npm ci` (it imports @earendil-works/chord and
 * typebox from node_modules):
 *
 *   node scripts/headless-smoke.mjs [http://127.0.0.1:7766] [--expect-lan | --expect-local]
 *
 * --expect-local: only this computer may connect — the builtin network-admission policy is in effect and only
 * 127.0.0.1 is advertised (the default); --expect-lan: other devices may — a user network-admission policy replaced
 * (or the builtin one was disabled) and at least one other address is advertised (e.g. migrated from --lan).
 *
 * Checks, one line each ("ok …" / "FAIL …"), exit code 0 only when all pass:
 *   1. GET / serves the web client (200, text/html, the React root);
 *   2. the WebSocket at /ws accepts a client that sends the right Origin;
 *   3. invoke network:status → enabled, listening, headless (and the admission policy state, when asked);
 *   4. invoke session:list → an array; session:create → a session;
 *   5. a view-sync link (chord) subscribes that session's view and receives a snapshot;
 *   6. invoke network:setEnabled(false) is refused (code "headless") and the server keeps listening;
 *   7. session:delete cleans up.
 *
 * Used by .github/workflows/linux-headless.yml against an installed deb, and by the macOS e2e
 * (apps/desktop/e2e/specs/startup/headless*.e2e.ts) against an isolated instance.
 */
import { createHost, remote } from '@earendil-works/chord'
import { Type } from 'typebox'

const STEP_TIMEOUT_MS = 20_000

const args = process.argv.slice(2)
const expectLan = args.includes('--expect-lan')
const expectLocal = args.includes('--expect-local')
const base = new URL(args.find((arg) => !arg.startsWith('--')) ?? 'http://127.0.0.1:7766')
const origin = `${base.protocol}//${base.host}`

function fail(step, reason) {
  console.log(`FAIL ${step}: ${reason}`)
  process.exit(1)
}

function ok(step, detail = '') {
  console.log(`ok ${step}${detail ? ` — ${detail}` : ''}`)
}

/** Wire envelope (apps/desktop/src/shared/networkEnvelope.ts): undefined positional args are listed in `u` */
function packArgs(args) {
  const u = []
  const out = args.map((arg, i) => {
    if (arg === undefined) {
      u.push(i)
      return null
    }
    return arg
  })
  return u.length > 0 ? { args: out, u } : { args: out }
}

function withTimeout(promise, step) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${STEP_TIMEOUT_MS} ms`)),
        STEP_TIMEOUT_MS
      )
    })
  ])
    .finally(() => clearTimeout(timer))
    .catch((error) => fail(step, error instanceof Error ? error.message : String(error)))
}

/** A chord Link over the socket's {t:'sync'} messages (same rules as agent-runtime's FrameLink) */
class SocketLink {
  #handler
  #queue = []
  #closeHandlers = new Set()
  #closed = false
  #transmit

  constructor(transmit) {
    this.#transmit = transmit
  }

  get closed() {
    return this.#closed
  }

  send(frame) {
    if (this.#closed) return
    try {
      this.#transmit(frame)
    } catch {
      this.ended('transport error')
    }
  }

  receive(handler) {
    this.#handler = handler
    for (const frame of this.#queue.splice(0)) handler(frame)
  }

  onClose(handler) {
    if (this.#closed) handler('closed')
    else this.#closeHandlers.add(handler)
  }

  close(reason = 'closed') {
    if (this.#closed) return
    try {
      this.#transmit({ t: 'bye', reason })
    } catch {
      // the socket may already be gone
    }
    this.ended(reason)
  }

  deliver(frame) {
    if (this.#closed) return
    if (frame && typeof frame === 'object' && frame.t === 'bye') {
      this.ended(typeof frame.reason === 'string' ? frame.reason : 'peer closed')
      return
    }
    if (this.#handler === undefined) this.#queue.push(frame)
    else this.#handler(frame)
  }

  ended(reason) {
    if (this.#closed) return
    this.#closed = true
    this.#queue = []
    for (const handler of [...this.#closeHandlers]) handler(reason)
    this.#closeHandlers.clear()
  }
}

/**
 * The session view contract (packages/agent-runtime/src/sync/viewContracts.ts) as a consumer: same name, version and
 * input; both state members are left unconstrained, which any provider schema covers
 */
const SessionViewContract = remote('shuvix.session-view', {
  version: 1,
  input: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
  variants: { owner: { state: { view: Type.Unknown(), availability: Type.Unknown() } } }
})

// 1. the web client
{
  const step = 'GET /'
  const res = await withTimeout(fetch(new URL('/', base)), step)
  const body = await res.text()
  if (res.status !== 200) fail(step, `status ${res.status}: ${body.slice(0, 200)}`)
  const type = res.headers.get('content-type') ?? ''
  if (!type.startsWith('text/html')) fail(step, `content-type ${type}`)
  if (!body.includes('<div id="root">')) fail(step, 'no React root in the page')
  ok(step, `${body.length} bytes of HTML`)
}

// 2. the socket
const wsUrl = `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}/ws`
const socket = await withTimeout(
  new Promise((resolve, reject) => {
    // Node 22's global WebSocket (undici) takes { headers }; a browser would send Origin by itself
    const ws = new WebSocket(wsUrl, { headers: { Origin: origin } })
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error(`could not connect to ${wsUrl}`)))
  }),
  'WebSocket /ws'
)
ok('WebSocket /ws', `Origin ${origin}`)

let nextId = 1
const pending = new Map()
const linkId = `smoke-${Math.random().toString(36).slice(2, 10)}`
const link = new SocketLink((frame) =>
  socket.send(JSON.stringify({ t: 'sync', link: linkId, frame }))
)
socket.addEventListener('message', (event) => {
  let message
  try {
    message = JSON.parse(String(event.data))
  } catch {
    return
  }
  if (message?.t === 'result') {
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  } else if (message?.t === 'sync' && message.link === linkId) {
    link.deliver(message.frame)
  }
})
socket.addEventListener('close', (event) => {
  link.ended('socket closed')
  for (const resolve of pending.values()) {
    resolve({
      ok: false,
      error: { message: `socket closed (${event.code})`, code: 'disconnected' }
    })
  }
  pending.clear()
})

function invoke(channel, ...args) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    socket.send(JSON.stringify({ t: 'invoke', id, channel, ...packArgs(args) }))
  })
}

async function invokeOk(step, channel, ...args) {
  const result = await withTimeout(invoke(channel, ...args), step)
  if (!result.ok)
    fail(step, `${result.error?.message ?? 'failed'} (${result.error?.code ?? 'no code'})`)
  return result.value
}

// 3. network status
{
  const step = 'network:status'
  const status = await invokeOk(step, 'network:status')
  if (status?.enabled !== true || status?.listening !== true) {
    fail(step, `not listening: ${JSON.stringify(status)}`)
  }
  if (status?.headless !== true) fail(step, `not headless: ${JSON.stringify(status)}`)
  if (!Array.isArray(status.addresses)) fail(step, `no address list: ${JSON.stringify(status)}`)
  const loopback = `http://127.0.0.1:${status.port}`
  const others = status.addresses.filter((a) => a !== loopback)
  if (expectLan) {
    if (status.admission === 'builtin' || typeof status.admission !== 'string') {
      fail(step, `expected a replaced network-admission policy: ${JSON.stringify(status)}`)
    }
    if (others.length === 0)
      fail(step, `advertises no other address: ${status.addresses.join(' ')}`)
  }
  if (expectLocal) {
    if (status.admission !== 'builtin') {
      fail(
        step,
        `expected the builtin network-admission (this computer only): ${JSON.stringify(status)}`
      )
    }
    if (status.addresses.length !== 1 || others.length > 0) {
      fail(step, `expected only ${loopback}, advertises: ${status.addresses.join(' ')}`)
    }
  }
  ok(step, `port ${status.port}, admission ${status.admission}, ${status.addresses.join(' ')}`)
}

// 4. sessions
const sessions = await invokeOk('session:list', 'session:list')
if (!Array.isArray(sessions)) fail('session:list', `not an array: ${JSON.stringify(sessions)}`)
ok('session:list', `${sessions.length} session(s)`)
const session = await invokeOk('session:create', 'session:create', {
  title: 'Headless smoke check'
})
if (typeof session?.id !== 'string') fail('session:create', `no id: ${JSON.stringify(session)}`)
ok('session:create', session.id)

// 5. the session's view over a view-sync link
{
  const step = 'view sync'
  const host = createHost({ name: `headless-smoke:${linkId}`, kind: 'client', onError: () => {} })
  host.connect(link, { pingTimeout: 60_000 })
  const handle = host.get(SessionViewContract, { sessionId: session.id }, { at: 'main' })
  handle.ready.catch(() => undefined)
  const stops = [handle.view.subscribe(() => {}), handle.availability.subscribe(() => {})]
  const view = await withTimeout(
    new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        if (handle.status === 'gone') {
          clearInterval(poll)
          reject(new Error(`subscription failed: ${handle.error?.message ?? handle.error}`))
        } else if (handle.status === 'live' && handle.view.value !== undefined) {
          clearInterval(poll)
          resolve(handle.view.value)
        }
      }, 50)
    }),
    step
  )
  if (view?.sessionId !== session.id) fail(step, `view of another session: ${view?.sessionId}`)
  if (!Array.isArray(view?.messages)) fail(step, 'the view has no message list')
  ok(
    step,
    `session view v${view.v}, ${view.messages.length} message(s), ${handle.availability.value}`
  )
  for (const stop of stops) stop()
  handle.release()
}

// 6. network access cannot be turned off from the browser
{
  const step = 'network:setEnabled(false) refused'
  const result = await withTimeout(invoke('network:setEnabled', false), step)
  if (result.ok) fail(step, 'it was accepted')
  if (result.error?.code !== 'headless')
    fail(step, `unexpected error: ${JSON.stringify(result.error)}`)
  const status = await invokeOk(step, 'network:status')
  if (status?.listening !== true) fail(step, 'the server stopped listening')
  ok(step, result.error.message)
}

// 7. clean up
await invokeOk('session:delete', 'session:delete', session.id)
ok('session:delete')

link.close('done')
socket.close()
console.log('headless smoke: all checks passed')
process.exit(0)
