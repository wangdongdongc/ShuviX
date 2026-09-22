/**
 * 原生消息宿主（`cli.js native-host`）—— Chrome 为扩展拉起的本地组件，在两种封帧之间透明转发。
 *
 * 只引 `../nativeHost`（`../index` 一引入就跑 main() 并 process.exit）。stdin / stdout 是 PassThrough，
 * stdout 用 NativeMessageReader 拆帧；桌面是一个真的 unix socket 服务端（按行切、可以回 ok / 回错 /
 * 压着不回），客户端 socket 一律 setEncoding('utf8')，免得测试夹具自己把多字节字符劈坏。
 *
 *   NH-F1~3  封帧：4 字节小端长度 + UTF-8 正文；逐字节 / 多帧 / 半帧 / 空帧 / 劈开的中文都拆得对
 *   NH-1~3   连上先发鉴权行；鉴权回来之前扩展的请求当场回 desktop-offline、事件丢掉；之后双向转发
 *            （扩展 → 桌面重新序列化成紧凑的一行，桌面 → 扩展原样一帧）
 *   NH-4~7   桌面状态只在变化时报（重连循环不刷屏）；鉴权被拒 = 断开重连；读不到 token 就不连，
 *            按 retryDelaysMs 退避
 *   NH-8     桌面不在时：带字符串 id 的请求当场回错，其余丢掉，宿主照常工作
 *   NH-9~11  桌面发来的行：超过 1 MB（按 UTF-8 字节量）的丢掉、坏行与空行丢掉、跨两次 write 的行
 *            拼回一次；多字节字符劈在两次 data 之间也不变成 U+FFFD
 *   NH-12~14 stdin 结束 / stop() / stdout 出错 → 宿主停下：done 兑现、socket 关掉、不再重连、不再写帧
 *   NH-15    stdout 上只有完整的帧、每帧都是 JSON；日志只走 opts.log
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'stream'
import { createServer, type Server, type Socket } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CHROME_NATIVE_MESSAGE_MAX_BYTES } from '@shuvix/chat-protocol/chromeBridge'
import {
  encodeNativeMessage,
  NativeMessageReader,
  runNativeHost,
  type NativeHostHandle,
  type NativeHostOptions
} from '../nativeHost'

const MAX = CHROME_NATIVE_MESSAGE_MAX_BYTES
const TOKEN = 'tok-native-host'
const AUTH_LINE = JSON.stringify({ auth: TOKEN })
const WAIT = { timeout: 3000, interval: 5 }

const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 可复现的伪随机（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─────────────────────────── 假桌面 ───────────────────────────

/** ok = 回 {auth:'ok'}；no = 回 {auth:'no'}；garbage = 回一行非 JSON；hold = 先不回（replyAuth 再回） */
type AuthMode = 'ok' | 'no' | 'garbage' | 'hold'

interface DesktopConn {
  socket: Socket
  /** 收到的每一行（第一行是鉴权行） */
  lines: string[]
  closed: boolean
  replyAuth: () => void
  /** 往本地组件写原始字节 / 文本 */
  write: (data: string | Buffer) => void
}

class FakeDesktop {
  server: Server | null = null
  readonly conns: DesktopConn[] = []

  constructor(
    readonly path: string,
    public auth: AuthMode = 'ok'
  ) {}

  async listen(): Promise<void> {
    rmSync(this.path, { force: true })
    const server = createServer((socket) => {
      socket.setEncoding('utf8')
      const conn: DesktopConn = {
        socket,
        lines: [],
        closed: false,
        replyAuth: () => socket.write('{"auth":"ok"}\n'),
        write: (data) => socket.write(data)
      }
      this.conns.push(conn)
      let rest = ''
      socket.on('data', (chunk: string) => {
        rest += chunk
        const parts = rest.split('\n')
        rest = parts.pop() ?? ''
        for (const line of parts) {
          conn.lines.push(line)
          if (conn.lines.length !== 1) continue
          if (this.auth === 'ok') socket.write('{"auth":"ok"}\n')
          else if (this.auth === 'no') socket.write('{"auth":"no"}\n')
          else if (this.auth === 'garbage') socket.write('not json\n')
        }
      })
      socket.on('error', () => {})
      socket.on('close', () => {
        conn.closed = true
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.path, () => resolve())
    })
    this.server = server
  }

  /** 断掉所有连接并停止监听 */
  async close(): Promise<void> {
    for (const conn of this.conns) conn.socket.destroy()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(this.path, { force: true })
  }
}

// ─────────────────────────── 扩展这一侧 ───────────────────────────

type Message = Record<string, unknown>

interface Extension {
  stdin: PassThrough
  stdout: PassThrough
  /** stdout 上的全部原始字节 */
  raw: Buffer[]
  /** 拆出来的每一帧正文 */
  bodies: string[]
  handle: NativeHostHandle
  log: ReturnType<typeof vi.fn>
  send: (message: unknown) => void
  sendText: (text: string) => void
  messages: () => Message[]
  /** 宿主报的桌面状态，按顺序 */
  statuses: () => string[]
  /** 不是宿主状态的帧（桌面转来的 / 宿主代答的） */
  relayed: () => string[]
}

let dir: string
let sockPath: string
const hosts: NativeHostHandle[] = []
const desktops: FakeDesktop[] = []

async function startDesktop(auth: AuthMode = 'ok'): Promise<FakeDesktop> {
  const desktop = new FakeDesktop(sockPath, auth)
  desktops.push(desktop)
  await desktop.listen()
  return desktop
}

function startHost(over: Partial<NativeHostOptions> = {}): Extension {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const reader = new NativeMessageReader()
  const raw: Buffer[] = []
  const bodies: string[] = []
  stdout.on('data', (chunk: Buffer) => {
    raw.push(chunk)
    bodies.push(...reader.push(chunk))
  })
  const log = vi.fn()
  const handle = runNativeHost(stdin, stdout, {
    socketPath: sockPath,
    readToken: () => TOKEN,
    retryDelaysMs: [20, 40],
    log,
    ...over
  })
  hosts.push(handle)
  const parsed = (): Message[] => bodies.map((body) => JSON.parse(body) as Message)
  return {
    stdin,
    stdout,
    raw,
    bodies,
    handle,
    log,
    send: (message) => stdin.write(encodeNativeMessage(JSON.stringify(message))),
    sendText: (text) => stdin.write(encodeNativeMessage(text)),
    messages: parsed,
    statuses: () =>
      parsed()
        .filter((m) => m.type === 'host')
        .map((m) => m.desktop as string),
    relayed: () => bodies.filter((body) => (JSON.parse(body) as Message).type !== 'host')
  }
}

const connected = (ext: Extension): Promise<void> =>
  vi.waitFor(() => expect(ext.statuses()).toContain('connected'), WAIT)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-'))
  sockPath = join(dir, 'd.sock')
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const handle of hosts.splice(0)) handle.stop()
  for (const desktop of desktops.splice(0)) await desktop.close()
  rmSync(dir, { recursive: true, force: true })
})

// ─────────────────────────── 用例 ───────────────────────────

describe('原生消息封帧', () => {
  it('NH-F1 encodeNativeMessage：4 字节小端长度（按 UTF-8 字节数）+ 正文；空串是 4 个 0', () => {
    expect([...encodeNativeMessage('{"a":1}')]).toEqual([7, 0, 0, 0, ...Buffer.from('{"a":1}')])
    expect([...encodeNativeMessage('中')]).toEqual([3, 0, 0, 0, 0xe4, 0xb8, 0xad])
    expect([...encodeNativeMessage('')]).toEqual([0, 0, 0, 0])
    // 长度是 32 位小端：258 = 0x0102
    expect([...encodeNativeMessage('a'.repeat(258)).subarray(0, 4)]).toEqual([2, 1, 0, 0])
  })

  it('NH-F2 NativeMessageReader：整帧、逐字节（含劈开的长度头）、两帧半、空帧、劈在中文中间的帧都拆得对', () => {
    const text = '{"x":"y"}'
    const frame = encodeNativeMessage(text)
    expect(new NativeMessageReader().push(frame)).toEqual([text])

    const slow = new NativeMessageReader()
    for (let i = 0; i < frame.length - 1; i++) {
      expect(slow.push(frame.subarray(i, i + 1))).toEqual([])
    }
    expect(slow.push(frame.subarray(frame.length - 1))).toEqual([text])

    const [a, b, c] = ['{"n":1}', '{"n":2}', '{"n":3,"t":"中文"}']
    const third = encodeNativeMessage(c)
    const reader = new NativeMessageReader()
    expect(
      reader.push(
        Buffer.concat([encodeNativeMessage(a), encodeNativeMessage(b), third.subarray(0, 6)])
      )
    ).toEqual([a, b])
    expect(reader.push(third.subarray(6))).toEqual([c])

    expect(new NativeMessageReader().push(Buffer.from([0, 0, 0, 0]))).toEqual([''])

    const zh = encodeNativeMessage('中文')
    const split = new NativeMessageReader()
    expect(split.push(zh.subarray(0, 5))).toEqual([]) // 长度头 + 「中」的第一个字节
    expect(split.push(zh.subarray(5))).toEqual(['中文'])
  })

  it('NH-F3 往返：随机的中英文 / emoji / 引号 / 换行字符串 push(encode(s)) 得回 [s]；连成一条流按随机块喂也一样', () => {
    const alphabet = ['a', 'Z', '0', ' ', '"', '\\', '\n', '{', '}', '中', '文', 'é', '😀', '👍🏽']
    const next = rng(42)
    const strings = Array.from({ length: 200 }, () =>
      Array.from(
        { length: Math.floor(next() * 40) },
        () => alphabet[Math.floor(next() * alphabet.length)]
      ).join('')
    )
    for (const s of strings)
      expect(new NativeMessageReader().push(encodeNativeMessage(s))).toEqual([s])

    const stream = Buffer.concat(strings.map((s) => encodeNativeMessage(s)))
    const reader = new NativeMessageReader()
    const out: string[] = []
    for (let offset = 0; offset < stream.length; ) {
      const size = 1 + Math.floor(next() * 50)
      out.push(...reader.push(stream.subarray(offset, offset + size)))
      offset += size
    }
    expect(out).toEqual(strings)
  })
})

describe.skipIf(process.platform === 'win32')('runNativeHost —— 真 unix socket 上的假桌面', () => {
  it('NH-1 桌面在：连上之后发的第一行恰是 {"auth":<token>}', async () => {
    const desktop = await startDesktop()
    startHost()

    await vi.waitFor(() => expect(desktop.conns[0]?.lines[0]).toBe(AUTH_LINE), WAIT)
    expect(AUTH_LINE).toBe(`{"auth":"${TOKEN}"}`)
  })

  it('NH-2 鉴权还没回来：扩展的请求当场回 desktop-offline、事件丢掉；鉴权通过后桌面一条也收不到', async () => {
    const desktop = await startDesktop('hold')
    const ext = startHost()
    await vi.waitFor(() => expect(desktop.conns[0]?.lines).toEqual([AUTH_LINE]), WAIT)

    ext.send({ type: 'request', id: 'p1', method: 'tabSession.open', params: { tabId: 5 } })
    ext.send({ type: 'event', name: 'tabs.removed', params: { tabId: 5 } })
    await vi.waitFor(
      () =>
        expect(ext.messages()).toContainEqual({
          type: 'response',
          id: 'p1',
          ok: false,
          error: 'desktop-offline'
        }),
      WAIT
    )

    desktop.conns[0].replyAuth()
    await connected(ext)
    await settle()

    expect(desktop.conns[0].lines).toEqual([AUTH_LINE])
    expect(ext.relayed().map((body) => JSON.parse(body))).toEqual([
      { type: 'response', id: 'p1', ok: false, error: 'desktop-offline' }
    ])
    // 代答时报的是 offline；连上之后必须再报一次 connected，扩展据此重说 hello
    expect(ext.statuses()).toEqual(['offline', 'connected'])
  })

  it('NH-3 鉴权通过后：恰报一次 connected；扩展的帧按序变成紧凑的一行；桌面的行原样变成一帧', async () => {
    const desktop = await startDesktop()
    const ext = startHost()
    await connected(ext)

    ext.sendText('{ "type" : "hello", "protocol": 1 }')
    ext.sendText('{"type":"event",\n "name":"a"}')
    ext.sendText('  {"type":"request","id":"p1","method":"m","params":{"t":"中文 😀"}}  ')
    await vi.waitFor(() => expect(desktop.conns[0].lines).toHaveLength(4), WAIT)
    expect(desktop.conns[0].lines).toEqual([
      AUTH_LINE,
      '{"type":"hello","protocol":1}',
      '{"type":"event","name":"a"}',
      '{"type":"request","id":"p1","method":"m","params":{"t":"中文 😀"}}'
    ])

    // 桌面 → 扩展不重新序列化：连空白都原样
    const lines = [
      '{"type":"event","name":"x","params":{"a":1}}',
      '{ "type": "response", "id": "p1", "ok": true, "result": "受信箱" }'
    ]
    desktop.conns[0].write(lines.join('\n') + '\n')
    await vi.waitFor(() => expect(ext.relayed()).toEqual(lines), WAIT)
    await settle()
    expect(ext.statuses()).toEqual(['connected'])
  })

  it('NH-4 桌面不在 → 起来 → 断掉 → 再起来：状态帧恰是 offline, connected, offline, connected（重试不重复报）', async () => {
    const desktop = new FakeDesktop(sockPath)
    desktops.push(desktop)
    const readToken = vi.fn(() => TOKEN)
    const ext = startHost({ readToken })

    await vi.waitFor(() => expect(ext.statuses()).toEqual(['offline']), WAIT)
    await settle(150)
    // 确实在重试（20ms、40ms、40ms…），只是不再报
    expect(readToken.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(ext.statuses()).toEqual(['offline'])

    await desktop.listen()
    await vi.waitFor(() => expect(ext.statuses()).toEqual(['offline', 'connected']), WAIT)

    await desktop.close()
    await vi.waitFor(
      () => expect(ext.statuses()).toEqual(['offline', 'connected', 'offline']),
      WAIT
    )
    const callsWhileDown = readToken.mock.calls.length
    await settle(150)
    expect(readToken.mock.calls.length).toBeGreaterThan(callsWhileDown)
    expect(ext.statuses()).toEqual(['offline', 'connected', 'offline'])

    await desktop.listen()
    await vi.waitFor(
      () => expect(ext.statuses()).toEqual(['offline', 'connected', 'offline', 'connected']),
      WAIT
    )
    await settle()
    expect(ext.statuses()).toEqual(['offline', 'connected', 'offline', 'connected'])
  })

  it('NH-5 桌面一开始就在：第一个状态帧就是 connected', async () => {
    await startDesktop()
    const ext = startHost()
    await connected(ext)
    await settle()
    expect(ext.statuses()).toEqual(['connected'])
    expect(ext.messages()[0]).toEqual({ type: 'host', desktop: 'connected' })
  })

  it.each([
    ['回 {auth:"no"}', 'no' as const],
    ['回一行不是 JSON 的东西', 'garbage' as const]
  ])(
    'NH-6 桌面%s：宿主断开、报 offline、重连（桌面看到第二条连接，第一行照样是鉴权行）',
    async (_l, mode) => {
      const desktop = await startDesktop(mode)
      const ext = startHost()

      await vi.waitFor(() => expect(desktop.conns.length).toBeGreaterThanOrEqual(2), WAIT)
      await vi.waitFor(() => expect(desktop.conns[0].closed).toBe(true), WAIT)
      await vi.waitFor(() => expect(desktop.conns[1].lines[0]).toBe(AUTH_LINE), WAIT)
      expect(ext.statuses()).toEqual(['offline'])
      expect(ext.log).toHaveBeenCalledWith(expect.stringMatching(/rejected/))
    }
  )

  it('NH-7 读不到 token（桌面从没启动过）：不连；offline 只报一次；按 [100,200,300] 退避在 0/100/300/600ms 重读；读到了就连上', async () => {
    const desktop = await startDesktop()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const t0 = Date.now()
    const calls: number[] = []
    const readToken = vi.fn(() => {
      calls.push(Date.now() - t0)
      return calls.length >= 4 ? TOKEN : undefined
    })
    const ext = startHost({ readToken, retryDelaysMs: [100, 200, 300] })

    expect(calls).toEqual([0])
    await vi.advanceTimersByTimeAsync(99)
    expect(calls).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual([0, 100])
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toEqual([0, 100, 300])
    await vi.advanceTimersByTimeAsync(299)
    expect(calls).toEqual([0, 100, 300])
    expect(ext.statuses()).toEqual(['offline'])
    expect(desktop.conns).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual([0, 100, 300, 600])
    vi.useRealTimers()

    await vi.waitFor(() => expect(ext.statuses()).toEqual(['offline', 'connected']), WAIT)
    expect(desktop.conns).toHaveLength(1)
    expect(desktop.conns[0].lines[0]).toBe(AUTH_LINE)
  })

  it('NH-8 桌面不在：带字符串 id 的请求当场回 desktop-offline（同一个 id）；数字 id / 没 id 的请求、事件、非 JSON 帧都不回；宿主照常工作', async () => {
    const ext = startHost()
    await vi.waitFor(() => expect(ext.statuses()).toEqual(['offline']), WAIT)

    ext.send({ type: 'request', id: 'r1', method: 'channel.call' })
    ext.send({ type: 'request', id: 7, method: 'channel.call' })
    ext.send({ type: 'request', method: 'channel.call' })
    ext.send({ type: 'event', name: 'tabs.removed', params: { tabId: 1 } })
    ext.sendText('not json')
    ext.send({ type: 'request', id: 'r2', method: 'panel.appearance' })

    const offline = (id: string): Message => ({
      type: 'response',
      id,
      ok: false,
      error: 'desktop-offline'
    })
    await vi.waitFor(() => expect(ext.relayed()).toHaveLength(2), WAIT)
    await settle()
    expect(ext.relayed().map((body) => JSON.parse(body))).toEqual([offline('r1'), offline('r2')])
    expect(ext.statuses()).toEqual(['offline'])

    // 还活着：桌面起来就连上
    await startDesktop()
    await vi.waitFor(() => expect(ext.statuses()).toEqual(['offline', 'connected']), WAIT)
  })

  it('NH-9 桌面发来的行按 UTF-8 字节量卡 1 MB：MAX+1 的丢掉、下一行照转；恰好 MAX 的照转；40 万个「中」（字符数不到上限）丢掉', async () => {
    const desktop = await startDesktop()
    const ext = startHost()
    await connected(ext)

    const head = '{"type":"event","name":"big","params":"'
    const tail = '"}'
    const ofBytes = (n: number): string => head + 'a'.repeat(n - head.length - tail.length) + tail
    const over = ofBytes(MAX + 1)
    const exact = ofBytes(MAX)
    const cjk = JSON.stringify({ type: 'event', name: 'cjk', params: '中'.repeat(400_000) })
    expect(Buffer.byteLength(exact)).toBe(MAX)
    expect(cjk.length).toBeLessThan(MAX)
    expect(Buffer.byteLength(cjk)).toBeGreaterThan(MAX)
    const afterOver = '{"type":"event","name":"after-over"}'
    const last = '{"type":"event","name":"last"}'

    desktop.conns[0].write([over, afterOver, exact, cjk, last].join('\n') + '\n')
    await vi.waitFor(() => expect(ext.relayed()).toContain(last), WAIT)

    const relayed = ext.relayed()
    expect(relayed.map((body) => body.length)).toEqual([afterOver.length, MAX, last.length])
    expect(relayed[0]).toBe(afterOver)
    expect(relayed[1] === exact).toBe(true)
    expect(relayed[2]).toBe(last)
    expect(ext.log.mock.calls.filter(([m]) => /oversized/.test(String(m)))).toHaveLength(2)
  })

  it('NH-10 坏行、空行丢掉，好行按序转；一行跨两次 write 只转一次、一字不差', async () => {
    const desktop = await startDesktop()
    const ext = startHost()
    await connected(ext)
    const [a, b, c] = ['a', 'b', 'c'].map((name) => JSON.stringify({ type: 'event', name }))

    desktop.conns[0].write(`${a}\n{broken\n\n\n   \n${b}\n`)
    desktop.conns[0].write(c.slice(0, 10))
    await settle(20)
    desktop.conns[0].write(c.slice(10) + '\n')

    await vi.waitFor(() => expect(ext.relayed()).toContain(c), WAIT)
    await settle()
    expect(ext.relayed()).toEqual([a, b, c])
  })

  it('NH-11 多字节字符（中文、emoji）劈在两次 write 之间（相隔约 20ms）：转出去的帧与原文一字不差、没有 U+FFFD', async () => {
    const desktop = await startDesktop()
    const ext = startHost()
    await connected(ext)

    const sent: string[] = []
    // 劈在「中」的第 1 / 2 个字节后、「😀」的第 1 / 2 / 3 个字节后
    for (const [char, offset] of [
      ['中', 1],
      ['中', 2],
      ['😀', 1],
      ['😀', 2],
      ['😀', 3]
    ] as const) {
      const line = JSON.stringify({
        type: 'event',
        name: `split-${sent.length}`,
        params: { text: '前文中文😀后文' }
      })
      const bytes = Buffer.from(line + '\n', 'utf8')
      const cut = bytes.indexOf(Buffer.from(char, 'utf8')) + offset
      desktop.conns[0].write(bytes.subarray(0, cut))
      await settle(20)
      desktop.conns[0].write(bytes.subarray(cut))
      sent.push(line)
    }

    await vi.waitFor(() => expect(ext.relayed()).toHaveLength(sent.length), WAIT)
    expect(ext.relayed()).toEqual(sent)
    for (const body of ext.relayed()) expect(body).not.toContain(String.fromCharCode(0xfffd))
  })

  it('NH-12 stdin 结束（扩展关了端口）：done 兑现、桌面看到连接关掉；桌面重启也不再连；之后一帧不写', async () => {
    const desktop = await startDesktop()
    const ext = startHost()
    await connected(ext)

    ext.stdin.end()
    await ext.handle.done
    await vi.waitFor(() => expect(desktop.conns[0].closed).toBe(true), WAIT)
    const frames = ext.bodies.length

    await desktop.close()
    await desktop.listen()
    await settle(150)
    expect(desktop.conns).toHaveLength(1)
    expect(ext.bodies).toHaveLength(frames)
  })

  it('NH-13 stop() 调两次：与 stdin 结束一样收尾，第二次什么也不做；等重连的宿主被 stop 后也不再连', async () => {
    const desktop = await startDesktop()
    const ext = startHost()
    await connected(ext)

    ext.handle.stop()
    ext.handle.stop()
    await ext.handle.done
    await vi.waitFor(() => expect(desktop.conns[0].closed).toBe(true), WAIT)
    const frames = ext.bodies.length
    await desktop.close()
    await desktop.listen()
    await settle(150)
    expect(desktop.conns).toHaveLength(1)
    expect(ext.bodies).toHaveLength(frames)

    // 另一个宿主：桌面不在、正等着重试时被 stop
    await desktop.close()
    const waiting = startHost()
    await vi.waitFor(() => expect(waiting.statuses()).toEqual(['offline']), WAIT)
    waiting.handle.stop()
    await waiting.handle.done
    await desktop.listen()
    await settle(150)
    expect(desktop.conns).toHaveLength(1)
    expect(waiting.statuses()).toEqual(['offline'])
  })

  it('NH-14 stdout 出错（Chrome 那头读不了了）：宿主停下、done 兑现、socket 关掉', async () => {
    const desktop = await startDesktop()
    const ext = startHost()
    await connected(ext)

    ext.stdout.emit('error', new Error('EPIPE'))
    await ext.handle.done
    await vi.waitFor(() => expect(desktop.conns[0].closed).toBe(true), WAIT)
  })

  it('NH-15 走一遍 NH-3 / NH-4 的场景：stdout 的字节恰好拆成整数个帧、每帧都是 JSON；日志只走 opts.log', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method)
    )
    const stdoutWrite = vi.spyOn(process.stdout, 'write')
    const stderrWrite = vi.spyOn(process.stderr, 'write')

    const desktop = new FakeDesktop(sockPath)
    desktops.push(desktop)
    const ext = startHost()
    await vi.waitFor(() => expect(ext.statuses()).toEqual(['offline']), WAIT)
    ext.send({ type: 'request', id: 'early', method: 'm' })
    await desktop.listen()
    await connected(ext)
    ext.send({ type: 'hello', protocol: 1 })
    desktop.conns[0].write('{"type":"welcome","protocol":1,"ok":true}\n{bad\n')
    await vi.waitFor(() => expect(ext.relayed()).toHaveLength(2), WAIT)
    await desktop.close()
    await desktop.listen()
    await vi.waitFor(
      () => expect(ext.statuses()).toEqual(['offline', 'connected', 'offline', 'connected']),
      WAIT
    )
    ext.handle.stop()
    await ext.handle.done

    const all = Buffer.concat(ext.raw)
    const bodies: string[] = []
    let offset = 0
    while (offset + 4 <= all.length) {
      const length = all.readUInt32LE(offset)
      expect(offset + 4 + length).toBeLessThanOrEqual(all.length)
      bodies.push(all.subarray(offset + 4, offset + 4 + length).toString('utf8'))
      offset += 4 + length
    }
    expect(offset).toBe(all.length)
    expect(bodies).toEqual(ext.bodies)
    for (const body of bodies) expect(() => JSON.parse(body), body).not.toThrow()

    expect(ext.log).toHaveBeenCalledWith('connected to the desktop')
    expect(ext.log).toHaveBeenCalledWith('desktop disconnected')
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    expect(stdoutWrite).not.toHaveBeenCalled()
    expect(stderrWrite).not.toHaveBeenCalled()
  })
})
