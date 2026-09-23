/**
 * 桥的两端连起来跑：真的本地组件（`cli/nativeHost`，stdin / stdout 是 PassThrough）⇄ 真 unix socket ⇄
 * 真的桥服务（`ChromeBridgeServer`）。扩展这一侧由测试扮演：往 stdin 写原生消息帧、从 stdout 拆帧。
 * 两端各自的单测都绿，而中间那段 socket 上的封帧 / 解码对不上时，只有这里会红。
 *
 *   RT-1  扩展的请求（tabSession.open）→ 桥服务的处理器 → 回应帧带同一个 id
 *   RT-2  桥服务的 request（tabs.get）→ stdout 上的请求帧；stdin 上作答 → resolve
 *   RT-3  2.5 MB 的 ASCII 事件：stdout 上全是分片帧、每帧不超 1 MB，拼回原事件
 *   RT-4  大段中文（含 emoji）两个方向：不必分片的 600 KB 行、要分片的 1 MB+ 事件、扩展发来的大请求 ——
 *         拼回来一字不差、没有 U+FFFD
 *   RT-5  桥服务 stop、同一路径起新的：本地组件报 offline → 重连 → connected；重说 hello 即就绪
 *   RT-6  桌面换**地址**重启：写地址文件 → 本地组件重读 → 连到新地址。地址那条链子（桌面写 /
 *         本地组件读 / 回落）只有这里从头到尾走一遍，而且是在非 Windows 上唯一能走通的地方
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'stream'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BridgeChunkAssembler,
  chromeBridgeAddressFile,
  CHROME_BRIDGE_PROTOCOL,
  CHROME_NATIVE_MESSAGE_MAX_BYTES,
  type BridgeChunk,
  type BridgeMessage
} from '@shuvix/chat-protocol/chromeBridge'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { ChromeBridgeServer, type BridgeConnection, type ChromeBridgeHandlers } from '../server'
/* eslint-disable boundaries/dependencies -- 往返用例有意把桥的两端放进同一个进程；产品代码两端互不引用 */
import {
  encodeNativeMessage,
  NativeMessageReader,
  resolveBridgeAddress,
  runNativeHost,
  type NativeHostHandle,
  type NativeHostOptions
} from '../../../../cli/nativeHost'
/* eslint-enable boundaries/dependencies */

const MAX = CHROME_NATIVE_MESSAGE_MAX_BYTES
const TOKEN = 'tok-round-trip'
const WAIT = { timeout: 5000, interval: 5 }
const BIG_WAIT = { timeout: 15_000, interval: 20 }
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd)

type Message = Record<string, unknown>

let dir: string
let sockPath: string
const servers: ChromeBridgeServer[] = []
const hosts: NativeHostHandle[] = []

async function startServer(
  handlers: ChromeBridgeHandlers = {},
  opts: { socketPath?: string; addressFile?: string } = {}
): Promise<ChromeBridgeServer> {
  const server = new ChromeBridgeServer()
  servers.push(server)
  server.setHandlers(handlers)
  await server.start({
    socketPath: opts.socketPath ?? sockPath,
    getToken: () => TOKEN,
    ...(opts.addressFile ? { addressFile: opts.addressFile } : {})
  })
  return server
}

/** 扩展这一侧：本地组件的 stdin / stdout */
function startExtension(socketPath: NativeHostOptions['socketPath'] = sockPath): {
  bodies: string[]
  send: (message: unknown) => void
  messages: (from?: number) => Message[]
  statuses: () => string[]
  waitFor: (predicate: (m: Message) => boolean, from?: number) => Promise<Message>
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const reader = new NativeMessageReader()
  const bodies: string[] = []
  stdout.on('data', (chunk: Buffer) => bodies.push(...reader.push(chunk)))
  hosts.push(
    runNativeHost(stdin, stdout, {
      socketPath,
      readToken: () => TOKEN,
      retryDelaysMs: [20, 40]
    })
  )
  const messages = (from = 0): Message[] =>
    bodies.slice(from).map((body) => JSON.parse(body) as Message)
  return {
    bodies,
    send: (message) => stdin.write(encodeNativeMessage(JSON.stringify(message))),
    messages,
    statuses: () =>
      messages()
        .filter((m) => m.type === 'host')
        .map((m) => m.desktop as string),
    waitFor: (predicate, from = 0) =>
      vi.waitFor(() => {
        const hit = messages(from).find(predicate)
        expect(hit).toBeDefined()
        return hit!
      }, WAIT)
  }
}

type Extension = ReturnType<typeof startExtension>

/** 等本地组件报 connected，说 hello，等 welcome；回桥服务那边的连接 */
async function handshake(
  ext: Extension,
  server: ChromeBridgeServer,
  installId = 'i1'
): Promise<BridgeConnection> {
  await vi.waitFor(() => expect(ext.statuses().at(-1)).toBe('connected'), WAIT)
  const from = ext.bodies.length
  ext.send({
    type: 'hello',
    protocol: CHROME_BRIDGE_PROTOCOL,
    extensionVersion: '0.3.0',
    installId,
    runId: 'r1',
    browser: 'Chrome 140',
    openTabIds: [5]
  })
  expect(await ext.waitFor((m) => m.type === 'welcome', from)).toEqual({
    type: 'welcome',
    protocol: 1,
    ok: true
  })
  const conn = server.connectionFor(installId)
  expect(conn?.ready).toBe(true)
  return conn!
}

/** 从 from 起收一整组分片（等到张数齐），回帧正文 */
function receiveChunks(ext: Extension, from: number): Promise<string[]> {
  return vi.waitFor(() => {
    const bodies = ext.bodies.slice(from)
    expect(bodies.length).toBeGreaterThan(0)
    const first = JSON.parse(bodies[0]) as BridgeChunk
    expect(first.type).toBe('chunk')
    expect(bodies).toHaveLength(first.total)
    return bodies
  }, BIG_WAIT)
}

function assemble(bodies: string[]): BridgeMessage | null {
  const assembler = new BridgeChunkAssembler()
  let whole: BridgeMessage | null = null
  for (const body of bodies) whole = assembler.push(JSON.parse(body) as BridgeChunk) ?? whole
  return whole
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-'))
  sockPath = join(dir, 'rt.sock')
})

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop()
  for (const server of servers.splice(0)) server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('Chrome 桥往返：真本地组件 ⇄ 真桥服务', () => {
  it('RT-1 扩展发 hello 后请求 tabSession.open：处理器拿到参数，stdout 上的回应带同一个 id', async () => {
    const onRequest = vi.fn(async () => ({ sessionId: 's-1' }))
    const server = await startServer({ onRequest })
    const ext = startExtension()
    const conn = await handshake(ext, server)

    ext.send({
      type: 'request',
      id: 'p1',
      method: 'tabSession.open',
      params: { tabId: 5, title: '收件箱 😀' }
    })
    expect(await ext.waitFor((m) => m.type === 'response')).toEqual({
      type: 'response',
      id: 'p1',
      ok: true,
      result: { sessionId: 's-1' }
    })
    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(onRequest).toHaveBeenCalledWith(conn, 'tabSession.open', {
      tabId: 5,
      title: '收件箱 😀'
    })
  })

  it('RT-2 桥服务 request(tabs.get)：stdout 上出现请求帧；在 stdin 上作答即 resolve', async () => {
    const server = await startServer()
    const ext = startExtension()
    const conn = await handshake(ext, server)

    const pending = conn.request('tabs.get', { tabId: 1 })
    const request = await ext.waitFor((m) => m.type === 'request')
    expect(request).toEqual({
      type: 'request',
      id: expect.stringMatching(/^d\d+$/),
      method: 'tabs.get',
      params: { tabId: 1 }
    })
    const tab = {
      id: 1,
      windowId: 3,
      title: '标题',
      url: 'https://a.example/',
      active: true,
      groupId: -1
    }
    ext.send({ type: 'response', id: request.id, ok: true, result: tab })
    await expect(pending).resolves.toEqual(tab)
  })

  it('RT-3 2.5 MB 的 ASCII 事件：stdout 上全是分片帧、每帧不超 1 MB，拼回来与原事件相同', async () => {
    const server = await startServer()
    const ext = startExtension()
    const conn = await handshake(ext, server)

    const params = { sessionId: 's', event: { type: 'tool_end', text: 'x'.repeat(2_500_000) } }
    const from = ext.bodies.length
    conn.emit('chat.event', params)
    const bodies = await receiveChunks(ext, from)

    expect(bodies.length).toBeGreaterThanOrEqual(2)
    for (const body of bodies) {
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX)
      expect((JSON.parse(body) as Message).type).toBe('chunk')
    }
    expect(assemble(bodies)).toEqual({ type: 'event', name: 'chat.event', params })
  })

  it('RT-4 大段中文与 emoji：600 KB 的整行、1 MB+ 的分片事件、扩展发来的 1 MB 请求 —— 两个方向都一字不差、没有 U+FFFD', async () => {
    const onRequest = vi.fn(async () => 'received')
    const server = await startServer({ onRequest })
    const ext = startExtension()
    const conn = await handshake(ext, server)

    // 不必分片：一整行 600 KB，socket 上必然被切成许多块，块边界落在字符中间
    const whole = { sessionId: 's', event: { text: '中文'.repeat(100_000) } }
    let from = ext.bodies.length
    conn.emit('chat.event', whole)
    const plain = await vi.waitFor(() => {
      const bodies = ext.bodies.slice(from)
      expect(bodies).toHaveLength(1)
      return bodies[0]
    }, BIG_WAIT)
    expect(plain).not.toContain(REPLACEMENT_CHAR)
    expect(JSON.parse(plain)).toEqual({ type: 'event', name: 'chat.event', params: whole })

    // 要分片：1 MB 以上，片与片、块与块的边界都可能劈开多字节字符
    const chunked = { sessionId: 's', event: { text: '中文テスト😀'.repeat(60_000) } }
    from = ext.bodies.length
    conn.emit('chat.event', chunked)
    const bodies = await receiveChunks(ext, from)
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    for (const body of bodies) expect(body).not.toContain(REPLACEMENT_CHAR)
    expect(assemble(bodies)).toEqual({ type: 'event', name: 'chat.event', params: chunked })

    // 反方向：扩展 → 本地组件 → 一行 1 MB → 桥服务按字节流解码
    const args = ['s1', '漢字😀'.repeat(100_000)]
    ext.send({
      type: 'request',
      id: 'big-up',
      method: 'channel.call',
      params: { path: 'agent.prompt', args }
    })
    expect(await ext.waitFor((m) => m.id === 'big-up')).toEqual({
      type: 'response',
      id: 'big-up',
      ok: true,
      result: 'received'
    })
    expect(onRequest).toHaveBeenCalledWith(conn, 'channel.call', { path: 'agent.prompt', args })
  })

  it('RT-5 桥服务 stop、同一路径起新的：本地组件报 offline、重连后报 connected；重说 hello 才就绪', async () => {
    const first = await startServer()
    const ext = startExtension()
    await handshake(ext, first)

    first.stop()
    await vi.waitFor(() => expect(ext.statuses()).toEqual(['connected', 'offline']), WAIT)

    const second = await startServer()
    await vi.waitFor(
      () => expect(ext.statuses()).toEqual(['connected', 'offline', 'connected']),
      WAIT
    )
    expect(second.connectionFor('i1')).toBeUndefined()

    const conn = await handshake(ext, second)
    expect(second.readyConnections()).toEqual([conn])
    expect(second.statuses()).toEqual([
      expect.objectContaining({ installId: 'i1', state: 'ready', protocol: 1 })
    ])
  })

  it('RT-6 桌面换**地址**重启：地址文件改写 → 本地组件重读 → 连到新地址、重说 hello 即就绪（地址靠猜的话，这里就永远停在 offline）', async () => {
    const addressFile = chromeBridgeAddressFile(dir)
    const pathA = join(dir, 'a.sock')
    const pathB = join(dir, 'b.sock')
    // 本地组件真正用的那个解析器：读地址文件，读不到回落到确定地址
    const env = { home: dir, platform: process.platform, user: 'shuvix-test' }

    const first = await startServer({}, { socketPath: pathA, addressFile })
    expect(readFileSync(addressFile, 'utf-8')).toBe(pathA)
    expect(resolveBridgeAddress(env)).toBe(pathA)

    const ext = startExtension(() => resolveBridgeAddress(env))
    await handshake(ext, first)

    first.stop()
    await vi.waitFor(() => expect(ext.statuses()).toEqual(['connected', 'offline']), WAIT)
    // 桌面退出时把地址文件也收走了：这期间解析器算出来的是回落地址，那里没人监听
    expect(existsSync(addressFile)).toBe(false)
    expect(resolveBridgeAddress(env)).toBe(join(dir, '.shuvix', 'chrome-bridge.sock'))

    const second = await startServer({}, { socketPath: pathB, addressFile })
    expect(readFileSync(addressFile, 'utf-8')).toBe(pathB)

    await vi.waitFor(
      () => expect(ext.statuses()).toEqual(['connected', 'offline', 'connected']),
      WAIT
    )
    const conn = await handshake(ext, second)
    expect(second.readyConnections()).toEqual([conn])
    expect(first.listening).toBe(false)
  })
})
