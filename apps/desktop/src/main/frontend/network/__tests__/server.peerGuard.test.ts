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
 *
 * 安全策略的点位（2026-10-19；服务带一个真的 NetworkPolicyGate，判定按可变的 decide 回，缺省放行）：
 *   NSP-6 request 拒绝 → GET / 403（规则的话 + 地址）、connection: close；升级 → 403、onConnection 不调；`/files/media`、
 *         `/lib/chart.js`、`/w/demo-widget/` → 403，依赖与 target() 不调；判定收到的对象是 request（method / path /
 *         query / route），主体带地址与请求头
 *   NSP-7 path 点位：`/files/media` 与 `/files/preview` 要读的位置（preview 是解析之后的）交给判定，tool = files + 路由名；
 *         拒绝 → 403、文件不读；放行 → 200 原文
 *   NSP-8 判定抛错 → 拒绝（fail closed：socket 点位抛 → 断开，request 点位抛 → 403）；不给 gate 的服务 → 不判，200
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
import { NetworkPolicyGate } from '../policyGate'
import type { GateVerdict, SecurityObject, SecuritySubject } from '@shuvix/agent-runtime'

const ALLOW: GateVerdict = {
  allowed: true,
  downgraded: false,
  decision: { effect: 'allow', tier: 'default', matched: [], winning: 'default:x' }
}

const DENY: GateVerdict = {
  allowed: false,
  downgraded: false,
  message: 'Not from here.',
  decision: { effect: 'deny', tier: 'deny', matched: ['p#0'], winning: 'p#0' }
}

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
let decide: (
  subject: SecuritySubject,
  action: string,
  object: SecurityObject,
  tool?: { name: string; operation?: string }
) => GateVerdict
let judged: Array<{
  subject: SecuritySubject
  action: string
  object: SecurityObject
  tool?: { name: string; operation?: string }
}>

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
  decide = () => ALLOW
  judged = []
  server = createNetworkServer({
    transport,
    dispatcher: createNetworkDispatcher({ definitionOf: transport.definitionOf }),
    links: createNetworkLinkHub({ accept: () => {} }),
    rendererDir: () => tmp,
    fileRoutes: () => ({ resolvePreviewPath, readSandboxLib }),
    widgetProxy: () => ({ target: widgetTarget }),
    gate: new NetworkPolicyGate({
      contextFor: () => (subject) => ({
        judgeGate: (action, object, opts) => {
          judged.push({ subject, action, object, tool: opts?.tool })
          return decide(subject, action, object, opts?.tool)
        }
      })
    }),
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
  path = '/',
  toPort = port
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: toPort, path, headers, agent: false },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
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

describe('NSP-6..NSP-8 安全策略的点位', () => {
  it('NSP-6 request 拒绝：静态、升级、动态路由都 403，依赖不调；判定看到的是 request 与带请求头的主体', async () => {
    decide = (_s, _a, object) => (object.type === 'request' ? DENY : ALLOW)
    const res = await http()
    expect(res.status).toBe(403)
    expect(res.body).toContain('Not from here.')
    expect(res.body).toContain('Address: 127.0.0.1')
    expect(res.headers.connection).toBe('close')
    const request = judged.find((j) => j.object.type === 'request')!
    expect(request.action).toBe('request')
    expect(request.object).toMatchObject({ method: 'GET', path: '/', query: {}, route: 'page' })
    expect(request.subject.kind).toBe('network')
    expect(request.subject.attrs).toMatchObject({
      address: '127.0.0.1',
      family: 'ipv4',
      connection: '',
      headers: expect.objectContaining({ host: `127.0.0.1:${port}` })
    })

    const upgrade = await upgradeStatus()
    expect(upgrade.status).toBe(403)
    expect(onConnection).not.toHaveBeenCalled()
    for (const path of [
      `/files/media?path=${encodeURIComponent(join(tmp, 'secret.txt'))}`,
      '/lib/chart.js',
      '/w/demo-widget/'
    ]) {
      const r = await http({}, path)
      expect(r.status, path).toBe(403)
    }
    expect(resolvePreviewPath).not.toHaveBeenCalled()
    expect(readSandboxLib).not.toHaveBeenCalled()
    expect(widgetTarget).not.toHaveBeenCalled()
  })

  it('NSP-7 path 点位：media / preview 要读的位置交给判定；拒绝 → 403 不读；放行 → 200', async () => {
    const secret = join(tmp, 'secret.txt')
    decide = (_s, _a, object) => (object.type === 'path' ? DENY : ALLOW)
    const media = await http({}, `/files/media?path=${encodeURIComponent(secret)}`)
    expect(media.status).toBe(403)
    expect(media.body).not.toContain('TOP-SECRET')
    const preview = await http({}, '/files/preview?session=s1&path=secret.txt')
    expect(preview.status).toBe(403)
    expect(resolvePreviewPath).toHaveBeenCalledWith('s1', 'secret.txt')
    const paths = judged.filter((j) => j.object.type === 'path')
    expect(paths.map((j) => [j.action, j.object.path, j.tool])).toEqual([
      ['read', secret, { name: 'files', operation: 'media' }],
      ['read', secret, { name: 'files', operation: 'preview' }]
    ])
    decide = () => ALLOW
    const ok = await http({}, `/files/media?path=${encodeURIComponent(secret)}`)
    expect(ok.status).toBe(200)
    expect(ok.body).toBe('TOP-SECRET')
  })

  it('NSP-8 判定抛错 → 拒绝；不给 gate 的服务 → 不判，200', async () => {
    // socket 点位就抛了：连接直接断开（HTTP 还没解析）
    decide = () => {
      throw new Error('policy md missing')
    }
    await expect(http()).rejects.toThrow()
    // 只有 request 点位抛：403
    decide = (_s, _a, object) => {
      if (object.type === 'socket') return ALLOW
      throw new Error('policy md missing')
    }
    expect((await http()).status).toBe(403)

    const transport = createNetworkTransport()
    const plainServer = createNetworkServer({
      transport,
      dispatcher: createNetworkDispatcher({ definitionOf: transport.definitionOf }),
      links: createNetworkLinkHub({ accept: () => {} }),
      rendererDir: () => tmp
    })
    const plainPort = await plainServer.start(0, '127.0.0.1')
    try {
      const res = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: plainPort, path: '/', agent: false },
          (r) => {
            r.resume()
            r.on('end', () => resolve(r.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end()
      })
      expect(res).toBe(200)
    } finally {
      await plainServer.stop()
    }
  })
})
