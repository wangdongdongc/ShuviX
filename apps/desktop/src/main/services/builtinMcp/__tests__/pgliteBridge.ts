/**
 * A real PostgreSQL on a local TCP port, for tests: PGlite (PostgreSQL compiled to WASM, in memory)
 * behind a small wire-protocol bridge, so the app's own `pg` driver connects to it exactly as it would
 * to a server. Shared by the unit tests next to this file and the desktop e2e specs (imported by
 * relative path — it depends on nothing but `node:*` and `@electric-sql/pglite`).
 *
 * ```ts
 * const bridge = await startPgliteBridge()
 * await bridge.db.exec('CREATE TABLE t (x int)')   // seed directly
 * // … point a saved connection at 127.0.0.1:${bridge.port} (any user / password / database) …
 * expect(bridge.log.queries).not.toContain('DELETE FROM t')   // "the SQL never reached the server"
 * await bridge.close()
 * ```
 *
 * **One backend session per bridge.** PGlite runs a single PostgreSQL session, so every TCP client of
 * one bridge shares it: a `SET`, an open transaction or `default_transaction_read_only` set through
 * one connection is seen by the next (even after the first one closed), and by `db.query()` too.
 * Use one bridge per saved connection, never put a read-only and a writable connection on the same
 * bridge, and seed a bridge before anything connects to it read-only.
 *
 * What the bridge does per connection: answers `SSLRequest` / `GSSENCRequest` with "no", replays
 * the handshake PGlite did once at start (any user name and password are accepted; the saved
 * database name is ignored), then forwards messages one at a time through one queue — an
 * extended-protocol sequence (`Parse` … `Sync`) is forwarded as a unit, so two connections can
 * never interleave inside each other's statement. `Terminate` closes the socket without reaching
 * PGlite.
 */
import net from 'node:net'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

export interface PgliteBridgeLog {
  /** TCP connections accepted since start */
  connections: number
  /** TCP connections open right now */
  open: number
  /**
   * The SQL text of every statement a client sent, in arrival order across all connections: simple
   * queries (`Q` messages) **and** extended-protocol statements (the query of each `Parse`/`P`
   * message) — `pg` sends a query with `queryMode: 'extended'` or with parameters as `P`, so a log
   * of `Q` messages alone would miss exactly those. Recorded on arrival, before PGlite runs it: a
   * statement the server rejected (a parse error, a read-only transaction) is still in the log.
   */
  queries: string[]
}

export interface PgliteBridge {
  /** The TCP port on 127.0.0.1 */
  port: number
  log: PgliteBridgeLog
  /** The PGlite instance behind the bridge — seed and inspect it directly (same single session) */
  db: PGlite
  /**
   * Drops every client socket but keeps listening, with PGlite's session intact — what a client sees
   * when the server restarts, the network drops, or a server-side idle timeout closes its connection
   */
  dropClients(): void
  /** Drops every client socket, stops listening and closes PGlite */
  close(): Promise<void>
}

const SSL_REQUEST = 80877103
const GSSENC_REQUEST = 80877104
const PROTOCOL_3_0 = 196608

/** Extended-protocol messages held back until the sequence's `Sync` (or any other message) */
const EXTENDED = new Set(['P', 'B', 'D', 'E', 'C'])

/** One backend message: type byte + int32 length (which counts itself) + body */
function message(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(5 + body.length)
  out.write(type, 0, 'latin1')
  out.writeInt32BE(4 + body.length, 1)
  body.copy(out, 5)
  return out
}

const bytes = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

/** The one handshake with PGlite; returns what a client must receive after its StartupMessage */
async function handshake(db: PGlite): Promise<Buffer> {
  const params = Buffer.from('user\0postgres\0database\0postgres\0\0', 'latin1')
  const startup = Buffer.alloc(8 + params.length)
  startup.writeInt32BE(8 + params.length, 0)
  startup.writeInt32BE(PROTOCOL_3_0, 4)
  params.copy(startup, 8)
  const first = Buffer.from(await db.execProtocolRaw(bytes(startup)))
  if (first[0] !== 'R'.charCodeAt(0)) throw new Error('PGlite did not answer the startup message')
  const auth = first.readInt32BE(5)
  // AuthenticationOk straight away
  if (auth === 0) return first
  let password: string
  if (auth === 5) {
    // AuthenticationMD5Password: 'md5' + md5(md5(password + user) + salt); the password is ignored
    const salt = first.subarray(9, 13)
    const inner = createHash('md5')
      .update('postgres' + 'postgres')
      .digest('hex')
    password =
      'md5' +
      createHash('md5')
        .update(Buffer.concat([Buffer.from(inner), salt]))
        .digest('hex')
  } else if (auth === 3) {
    password = 'postgres'
  } else {
    throw new Error(`PGlite asked for an unsupported authentication method (${auth})`)
  }
  const hello = Buffer.from(
    await db.execProtocolRaw(bytes(message('p', Buffer.from(password + '\0', 'latin1'))))
  )
  // AuthenticationOk, ParameterStatus…, BackendKeyData, ReadyForQuery
  if (hello[0] !== 'R'.charCodeAt(0) || hello.readInt32BE(5) !== 0) {
    throw new Error('PGlite refused the bridge handshake')
  }
  return hello
}

/** The SQL a client message carries, if any (`Q`: the query; `P`: name\0 query\0 …) */
function sqlOf(frame: Buffer): string | undefined {
  const type = String.fromCharCode(frame[0])
  const body = frame.subarray(5)
  const cstring = (from: number): [string, number] => {
    const end = body.indexOf(0, from)
    const stop = end < 0 ? body.length : end
    return [body.subarray(from, stop).toString('utf8'), stop + 1]
  }
  if (type === 'Q') return cstring(0)[0]
  if (type === 'P') {
    const [, afterName] = cstring(0)
    return cstring(afterName)[0]
  }
  return undefined
}

/** Starts PGlite and a bridge to it on 127.0.0.1 (an ephemeral port) */
export async function startPgliteBridge(): Promise<PgliteBridge> {
  const db = new PGlite()
  await db.waitReady
  const hello = await handshake(db)

  const log: PgliteBridgeLog = { connections: 0, open: 0, queries: [] }
  const sockets = new Set<net.Socket>()
  // PGlite is one session: everything it runs goes through this queue, one batch at a time
  let queue: Promise<void> = Promise.resolve()

  const server = net.createServer((sock) => {
    log.connections++
    log.open++
    sockets.add(sock)
    sock.setNoDelay(true)
    sock.on('close', () => {
      log.open--
      sockets.delete(sock)
    })
    sock.on('error', () => {})

    let buffer = Buffer.alloc(0)
    let started = false
    let pending: Buffer[] = []

    const forward = (batch: Buffer[]): void => {
      queue = queue
        .then(async () => {
          for (const frame of batch) {
            if (sock.destroyed) return
            const out = await db.execProtocolRaw(bytes(frame))
            if (!sock.destroyed && out.length > 0) sock.write(Buffer.from(out))
          }
        })
        .catch(() => {
          sock.destroy()
        })
    }

    sock.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (!started) {
          // Startup phase: int32 length + int32 code (+ parameters)
          if (buffer.length < 8) return
          const length = buffer.readInt32BE(0)
          if (buffer.length < length) return
          const code = buffer.readInt32BE(4)
          buffer = buffer.subarray(length)
          if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
            sock.write('N')
            continue
          }
          if (code !== PROTOCOL_3_0) {
            // CancelRequest or an unknown protocol: nothing a test relies on
            sock.end()
            return
          }
          started = true
          sock.write(hello)
          continue
        }
        if (buffer.length < 5) return
        const length = buffer.readInt32BE(1)
        if (buffer.length < 1 + length) return
        const frame = Buffer.from(buffer.subarray(0, 1 + length))
        buffer = buffer.subarray(1 + length)
        const type = String.fromCharCode(frame[0])
        if (type === 'X') {
          // Terminate: close this client; PGlite's session lives on for the others
          sock.end()
          return
        }
        const sql = sqlOf(frame)
        if (sql !== undefined) log.queries.push(sql)
        if (EXTENDED.has(type)) {
          pending.push(frame)
          continue
        }
        forward([...pending, frame])
        pending = []
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the bridge has no TCP port')

  return {
    port: address.port,
    log,
    db,
    dropClients: () => {
      for (const sock of sockets) sock.destroy()
    },
    close: async () => {
      for (const sock of sockets) sock.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await queue.catch(() => {})
      await db.close()
    }
  }
}
