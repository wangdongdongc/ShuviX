/**
 * `frontend/network/server.ts` 的第一道门（对端地址必须私有）—— 真的服务绑 127.0.0.1，只能从回环连进来，所以把
 * `guards.isPrivatePeerAddress` 换成包着真实现的 spy，逐条用例切成「不是私有地址」。
 *
 *   NSP-1 HTTP GET / 带合法 Host → 403 'ShuviX only accepts connections from the local network.'，connection: close
 *   NSP-2 升级带合法 Host 与 Origin → 403；onConnection 不调
 *   NSP-3 非私有对端 + 坏 Host → 403 而不是 421（先查对端）
 *   NSP-4 换回真实现 → 200
 *   NSP-5 phase D 的动态路由也先过这道门：`/files/media?path=…`、`/lib/chart.js`、`/w/demo-widget/` → 403，
 *         connection: close；文件路由的依赖与 widget 转发的 target() 一次都不调
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import * as guards from '../guards'
import { createNetworkDispatcher } from '../dispatch'
import { createNetworkLinkHub } from '../networkLinks'
import { createNetworkServer, type NetworkServer } from '../server'
import { createNetworkTransport, type NetworkConnection } from '../transport'

vi.mock('../guards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../guards')>()
  return { ...real, isPrivatePeerAddress: vi.fn(real.isPrivatePeerAddress) }
})

const isPrivate = vi.mocked(guards.isPrivatePeerAddress)
const FORBIDDEN = 'ShuviX only accepts connections from the local network.'

let tmp: string
let server: NetworkServer
let port: number
let onConnection: ReturnType<typeof vi.fn<(connection: NetworkConnection) => void>>
let resolvePreviewPath: ReturnType<typeof vi.fn<(sessionId: string, path: string) => string>>
let readSandboxLib: ReturnType<typeof vi.fn<(name: string) => Promise<Buffer | undefined>>>
let widgetTarget: ReturnType<typeof vi.fn<() => { host: string; port: number } | undefined>>
let realImpl: (address: string | undefined | null) => boolean

beforeEach(async () => {
  realImpl = isPrivate.getMockImplementation()!
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-net-peer-'))
  writeFileSync(join(tmp, 'web.html'), '<p>web</p>')
  const transport = createNetworkTransport()
  onConnection = vi.fn()
  writeFileSync(join(tmp, 'secret.txt'), 'TOP-SECRET')
  resolvePreviewPath = vi.fn((_sessionId: string, path: string) => join(tmp, path))
  readSandboxLib = vi.fn(async () => Buffer.from('lib'))
  widgetTarget = vi.fn(() => ({ host: '127.0.0.1', port: 9 }))
  server = createNetworkServer({
    transport,
    dispatcher: createNetworkDispatcher({ definitionOf: transport.definitionOf }),
    links: createNetworkLinkHub({ accept: () => {} }),
    rendererDir: () => tmp,
    fileRoutes: () => ({ resolvePreviewPath, readSandboxLib }),
    widgetProxy: () => ({ target: widgetTarget }),
    onConnection
  })
  port = await server.start(0, '127.0.0.1')
})

afterEach(async () => {
  isPrivate.mockImplementation(realImpl)
  await server.stop()
  rmSync(tmp, { recursive: true, force: true })
})

function http(
  headers: Record<string, string> = {},
  path = '/'
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function upgradeStatus(): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` })
    let settled = false
    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => {
        settled = true
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    ws.on('open', () => {
      settled = true
      ws.terminate()
      reject(new Error('the upgrade was accepted'))
    })
    ws.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

describe('NSP 对端地址那道门', () => {
  it('NSP-1 HTTP GET / → 403，connection: close', async () => {
    isPrivate.mockReturnValue(false)
    const res = await http()
    expect(res.status).toBe(403)
    expect(res.body).toBe(FORBIDDEN)
    expect(res.headers.connection).toBe('close')
    expect(isPrivate).toHaveBeenCalledWith('127.0.0.1')
  })

  it('NSP-2 升级 → 403；onConnection 不调', async () => {
    isPrivate.mockReturnValue(false)
    const res = await upgradeStatus()
    expect(res.status).toBe(403)
    expect(res.body).toBe(FORBIDDEN)
    expect(onConnection).not.toHaveBeenCalled()
  })

  it('NSP-3 非私有对端 + 坏 Host → 403 而不是 421', async () => {
    isPrivate.mockReturnValue(false)
    const res = await http({ Host: `evil:${port}` })
    expect(res.status).toBe(403)
    expect(res.body).toBe(FORBIDDEN)
  })

  it('NSP-4 换回真实现 → 200', async () => {
    isPrivate.mockReturnValue(false)
    expect((await http()).status).toBe(403)
    isPrivate.mockImplementation(realImpl)
    const res = await http()
    expect(res.status).toBe(200)
    expect(res.body).toBe('<p>web</p>')
  })

  it('NSP-5 /files/media、/lib/chart.js、/w/demo-widget/ → 403 connection: close；依赖与 target() 都不调', async () => {
    isPrivate.mockReturnValue(false)
    for (const path of [
      `/files/media?path=${encodeURIComponent(join(tmp, 'secret.txt'))}`,
      '/files/preview?session=s1&path=secret.txt',
      '/lib/chart.js',
      '/w/demo-widget/'
    ]) {
      const res = await http({}, path)
      expect(res.status, path).toBe(403)
      expect(res.body, path).toBe(FORBIDDEN)
      expect(res.headers.connection, path).toBe('close')
    }
    expect(resolvePreviewPath).not.toHaveBeenCalled()
    expect(readSandboxLib).not.toHaveBeenCalled()
    expect(widgetTarget).not.toHaveBeenCalled()

    // 正控制组：门一放开，同样的请求确实走到了这些依赖
    isPrivate.mockImplementation(realImpl)
    const lib = await http({}, '/lib/chart.js')
    expect(lib.status).toBe(200)
    expect(readSandboxLib).toHaveBeenCalledWith('chart.js')
  })
})
