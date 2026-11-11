/**
 * `frontend/network/policyGate.ts` —— 远程访问的策略点位（2026-10-19，docs/network-policy/design.md）：
 *
 *   PG-1 设备 cookie：新 ID 是 22 位 base64url；Set-Cookie 带 Path=/、HttpOnly、SameSite=Strict；parseCookies 认引号、
 *        URI 编码、同名取第一个；deviceOfCookieHeader 只认 22 位 base64url
 *   PG-2 事实：peerFactsOf 拆开 IPv4 映射、给地址族；httpFactsOf 键小写、多值连接、取设备与 UA
 *   PG-3 主体：每个阶段都给齐全部键（socket 阶段 headers {}、device ''）；interface / cookies 惰性（没读不算）、不进 JSON
 *   PG-4 requestRouteOf / requestTarget / channelGroupOf
 *   PG-5 四个点位交给判定的 action / 对象 / tool；channel 的 args 惰性、不进 JSON；access 来自通道表；request / channel /
 *        path 都带 scope 与 access（settings:set 按 key、文件路由是 files、/w/ 的写方法是 write）
 *   PG-4+ / PG-5+ 会话里摆给用户看的图（`/sessions/shown-image`，show_image 的快照）：去处是 shown（带尾斜杠的不是，
 *        落到 asset）；request 对象归 sessions scope —— GET / HEAD / OPTIONS 读、POST 写；拒绝记录 stage request、scope sessions
 *   PG-6 拒绝记录：放行不记；同一（地址、设备、规则、摘要）一分钟内合并、过了窗口另起一条；新 ID 记进 device；
 *        最多 200 条；onChange 只在新条目时调
 *   PG-7 判定抛错 → 拒绝（fail closed）且记一条 rule 'error'；没接上 → 一律放行
 *   PG-LIB-1 文件库（`/files/library`，L1）：去处是 library；requestFactsOf('library', GET / HEAD / OPTIONS) → files + read，
 *        POST → write；一条按 scope 拒掉 files 的规则在 request 这一步拒掉 GET /files/library（拒绝记录 stage request、scope files）
 */
import { describe, expect, it, vi } from 'vitest'
import type { networkInterfaces } from 'node:os'
import type { GateVerdict, SecurityObject, SecuritySubject } from '@shuvix/agent-runtime'
import { channelGroupOf } from '../../../../shared/channelAccess'
import {
  deviceCookieHeader,
  deviceOfCookieHeader,
  httpFactsOf,
  interfaceNameOf,
  MAX_NETWORK_DENIALS,
  NETWORK_DENIAL_WINDOW_MS,
  NetworkDenialLog,
  NetworkPolicyGate,
  networkSubject,
  newDeviceId,
  parseCookies,
  peerFactsOf,
  requestFactsOf,
  requestRouteOf,
  requestTarget,
  type RequestRoute
} from '../policyGate'

const ALLOW: GateVerdict = {
  allowed: true,
  downgraded: false,
  decision: { effect: 'allow', tier: 'default', matched: [], winning: 'default:x' }
}

const DENY: GateVerdict = {
  allowed: false,
  downgraded: false,
  message: 'No.',
  decision: {
    effect: 'deny',
    tier: 'deny',
    matched: ['p#0'],
    winning: 'p#0',
    prompt: { text: 'No.', rules: ['p#0'], policies: ['P'] }
  }
}

const IFACES = {
  en0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
} as unknown as ReturnType<typeof networkInterfaces>

const PEER = peerFactsOf({
  remoteAddress: '::ffff:192.168.1.23',
  remotePort: 51000,
  localAddress: '::ffff:192.168.1.10',
  localPort: 7766
})

const DEVICE = 'AAAAAAAAAAAAAAAAAAAAAA'

const HTTP = httpFactsOf({
  headers: { 'user-agent': 'Safari', cookie: `shuvix_device=${DEVICE}`, host: '192.168.1.10:7766' }
})

describe('PG-1 设备 cookie', () => {
  it('PG-1 新 ID、Set-Cookie、解析', () => {
    const id = newDeviceId()
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(newDeviceId()).not.toBe(id)
    expect(deviceCookieHeader(id)).toBe(
      `shuvix_device=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000`
    )
    expect(parseCookies('a=1; b="two"; c=%E4%BD%A0; a=9; bad; =x; d=%zz')).toEqual({
      a: '1',
      b: 'two',
      c: '你',
      d: '%zz'
    })
    expect(deviceOfCookieHeader(`x=1; shuvix_device=${DEVICE}`)).toBe(DEVICE)
    expect(deviceOfCookieHeader('shuvix_device=short')).toBe('')
    expect(deviceOfCookieHeader(`shuvix_device=${DEVICE}x`)).toBe('')
    expect(deviceOfCookieHeader(undefined)).toBe('')
  })
})

describe('PG-2 事实', () => {
  it('PG-2 peerFactsOf / httpFactsOf', () => {
    expect(PEER).toEqual({
      address: '192.168.1.23',
      port: 51000,
      localAddress: '192.168.1.10',
      localPort: 7766,
      family: 'ipv4'
    })
    expect(peerFactsOf({ remoteAddress: 'fe80::1', localAddress: 'fe80::2' })).toMatchObject({
      family: 'ipv6',
      port: 0,
      localPort: 0
    })
    expect(
      httpFactsOf({ headers: { 'X-Thing': ['a', 'b'], 'user-agent': 'UA', missing: undefined } })
    ).toEqual({ headers: { 'x-thing': 'a, b', 'user-agent': 'UA' }, device: '', userAgent: 'UA' })
    expect(HTTP.device).toBe(DEVICE)
  })
})

describe('PG-3 主体', () => {
  it('PG-3 全部键；网卡与 cookie 惰性、不进 JSON', () => {
    const interfaces = vi.fn(() => IFACES)
    const socketStage = networkSubject(PEER, undefined, '', interfaces)
    expect(socketStage.kind).toBe('network')
    expect(socketStage.attrs).toMatchObject({
      address: '192.168.1.23',
      headers: {},
      device: '',
      userAgent: '',
      connection: ''
    })
    expect(interfaces).not.toHaveBeenCalled()
    const json = JSON.parse(JSON.stringify(socketStage.attrs))
    expect('interface' in json || 'cookies' in json).toBe(false)
    expect(socketStage.attrs!.interface).toBe('en0')
    expect(socketStage.attrs!.interface).toBe('en0')
    expect(interfaces).toHaveBeenCalledTimes(1)
    expect(socketStage.attrs!.cookies).toEqual({})

    const rpc = networkSubject(PEER, HTTP, 'ws:3', () => IFACES)
    expect(rpc.attrs).toMatchObject({ device: DEVICE, userAgent: 'Safari', connection: 'ws:3' })
    expect(rpc.attrs!.cookies).toEqual({ shuvix_device: DEVICE })
    expect(interfaceNameOf('10.9.9.9', IFACES)).toBe('')
    expect(interfaceNameOf('nope', IFACES)).toBe('')
  })
})

describe('PG-4 去处、地址、命名空间', () => {
  it('PG-4', () => {
    expect(requestRouteOf('/', false)).toBe('page')
    expect(requestRouteOf('/web.html', false)).toBe('page')
    expect(requestRouteOf('/assets/x.js', false)).toBe('asset')
    expect(requestRouteOf('/ws', false)).toBe('socket')
    expect(requestRouteOf('/anything', true)).toBe('socket')
    expect(requestRouteOf('/files/media', false)).toBe('media')
    expect(requestRouteOf('/files/preview', false)).toBe('preview')
    expect(requestRouteOf('/files/download', false)).toBe('download')
    expect(requestRouteOf('/lib/chart.js', false)).toBe('lib')
    expect(requestRouteOf('/w/abc/', false)).toBe('widget')
    expect(requestTarget('/files/media?path=%2Ftmp%2Fa&path=b&x')).toEqual({
      path: '/files/media',
      query: { path: '/tmp/a', x: '' }
    })
    expect(requestTarget(undefined)).toEqual({ path: '/', query: {} })
    expect(channelGroupOf('session:list')).toBe('session')
    expect(channelGroupOf('network:setPort')).toBe('network')
    expect(channelGroupOf('nope:nope')).toBe('')
  })

  it('PG-4+ /sessions/shown-image → shown；带尾斜杠 → asset', () => {
    expect(requestRouteOf('/sessions/shown-image', false)).toBe('shown')
    expect(requestRouteOf('/sessions/shown-image/', false)).toBe('asset')
  })
})

/** 记下每次判定的门 */
function recordingGate(
  decide: (object: SecurityObject) => GateVerdict = () => ALLOW,
  denials = new NetworkDenialLog()
): {
  gate: NetworkPolicyGate
  calls: Array<{
    subject: SecuritySubject
    action: string
    object: SecurityObject
    tool?: { name: string; operation?: string }
  }>
  denials: NetworkDenialLog
} {
  const calls: Array<{
    subject: SecuritySubject
    action: string
    object: SecurityObject
    tool?: { name: string; operation?: string }
  }> = []
  const gate = new NetworkPolicyGate({
    contextFor: () => (subject) => ({
      judgeGate: (action, object, opts) => {
        calls.push({ subject, action, object, tool: opts?.tool })
        return decide(object)
      }
    }),
    interfaces: () => IFACES,
    denials
  })
  return { gate, calls, denials }
}

describe('PG-5 四个点位', () => {
  it('PG-5 action / 对象 / tool', () => {
    const { gate, calls } = recordingGate()
    gate.judgeSocket(PEER)
    gate.judgeRequest(PEER, HTTP, { method: 'GET', path: '/', query: {}, route: 'page' })
    const args = [{ text: 'hi' }]
    gate.judgeChannel(PEER, HTTP, 'ws:1', {
      channel: 'session:list',
      kind: 'invoke',
      size: 42,
      args
    })
    gate.judgePath(PEER, HTTP, 'ws:1', 'write', '/tmp/a.md', { name: 'files', operation: 'write' })
    expect(calls.map((c) => [c.action, c.object.type])).toEqual([
      ['connect', 'socket'],
      ['request', 'request'],
      ['invoke', 'channel'],
      ['write', 'path']
    ])
    expect(calls[1].object).toEqual({
      type: 'request',
      method: 'GET',
      path: '/',
      query: {},
      route: 'page',
      scope: 'app',
      access: 'read'
    })
    const channel = calls[2].object
    expect(channel).toMatchObject({
      type: 'channel',
      channel: 'session:list',
      group: 'session',
      scope: 'sessions',
      kind: 'invoke',
      access: 'read',
      size: 42
    })
    expect(channel.args).toBe(args)
    expect('args' in JSON.parse(JSON.stringify(channel))).toBe(false)
    expect(calls[2].subject.attrs?.connection).toBe('ws:1')
    expect(calls[3].object).toEqual({
      type: 'path',
      path: '/tmp/a.md',
      displayPath: '/tmp/a.md',
      scope: 'files',
      access: 'write'
    })
    expect(calls[3].tool).toEqual({ name: 'files', operation: 'write' })
  })

  it('PG-5 scope 与 access：settings:set 按 key；文件路由与 widget 路由；写方法', () => {
    const { gate, calls } = recordingGate()
    const set = (key: unknown): void => {
      gate.judgeChannel(PEER, HTTP, 'ws:1', {
        channel: 'settings:set',
        kind: 'invoke',
        size: 10,
        args: [{ key, value: 'x' }]
      })
    }
    set('general.theme')
    set('sandbox.enabled')
    set('no.such.key')
    expect(calls.map((c) => [c.object.scope, c.object.access])).toEqual([
      ['preferences', 'write'],
      ['security', 'admin'],
      ['system', 'admin']
    ])
    // 拒绝记录的摘要带着 key（settings:set 按 key 定 scope，光写通道名分不出是哪一项）
    const denials = new NetworkDenialLog()
    const { gate: refusing } = recordingGate(() => DENY, denials)
    refusing.judgeChannel(PEER, HTTP, 'ws:1', {
      channel: 'settings:set',
      kind: 'invoke',
      size: 10,
      args: [{ key: 'sandbox.enabled', value: 'false' }]
    })
    expect(denials.recent()).toMatchObject([
      { stage: 'channel', summary: 'settings:set sandbox.enabled', scope: 'security' }
    ])
    calls.length = 0
    const request = (method: string, path: string, route: RequestRoute): void => {
      gate.judgeRequest(PEER, HTTP, { method, path, query: {}, route })
    }
    request('GET', '/files/media', 'media')
    request('GET', '/w/x/', 'widget')
    request('POST', '/w/x/api', 'widget')
    request('GET', '/ws', 'socket')
    expect(calls.map((c) => [c.object.scope, c.object.access])).toEqual([
      ['files', 'read'],
      ['widgets', 'read'],
      ['widgets', 'write'],
      ['app', 'read']
    ])
  })
})

describe('PG-5+ 摆给用户看的图的请求', () => {
  it('PG-5+ route shown → sessions scope；GET / HEAD / OPTIONS 读、POST 写；拒绝记录 stage request、scope sessions', () => {
    const { gate, calls } = recordingGate()
    const query = { session: 'S', file: 'f' }
    gate.judgeRequest(PEER, HTTP, {
      method: 'GET',
      path: '/sessions/shown-image',
      query,
      route: 'shown'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].action).toBe('request')
    expect(calls[0].object).toEqual({
      type: 'request',
      method: 'GET',
      path: '/sessions/shown-image',
      query: { session: 'S', file: 'f' },
      route: 'shown',
      scope: 'sessions',
      access: 'read'
    })

    calls.length = 0
    for (const method of ['HEAD', 'OPTIONS', 'POST']) {
      gate.judgeRequest(PEER, HTTP, {
        method,
        path: '/sessions/shown-image',
        query,
        route: 'shown'
      })
    }
    expect(calls.map((c) => [c.object.scope, c.object.access])).toEqual([
      ['sessions', 'read'],
      ['sessions', 'read'],
      ['sessions', 'write']
    ])

    const denials = new NetworkDenialLog()
    const { gate: refusing } = recordingGate(() => DENY, denials)
    const verdict = refusing.judgeRequest(PEER, HTTP, {
      method: 'GET',
      path: '/sessions/shown-image',
      query,
      route: 'shown'
    })
    expect(verdict.allowed).toBe(false)
    expect(denials.recent()).toMatchObject([
      { stage: 'request', summary: 'GET /sessions/shown-image', scope: 'sessions' }
    ])
  })
})

describe('PG-LIB-1 文件库的请求', () => {
  it('PG-LIB-1 requestRouteOf：/files/library → library', () => {
    expect(requestRouteOf('/files/library', false)).toBe('library')
    expect(requestRouteOf('/files/library/', false)).toBe('asset')
  })

  it('PG-LIB-1 requestFactsOf：GET / HEAD / OPTIONS → files + read；POST → files + write', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(requestFactsOf('library', method), method).toEqual({ scope: 'files', access: 'read' })
    }
    expect(requestFactsOf('library', 'POST')).toEqual({ scope: 'files', access: 'write' })
  })

  it('PG-LIB-1 按 scope 拒掉 files 的规则：在 request 这一步拒掉 GET /files/library；拒 sessions 的规则挡不住它', () => {
    const query = { id: '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10' }
    const judge = (gate: NetworkPolicyGate): GateVerdict =>
      gate.judgeRequest(PEER, HTTP, {
        method: 'GET',
        path: '/files/library',
        query,
        route: 'library'
      })

    const denials = new NetworkDenialLog()
    const filesDenied = recordingGate(
      (object) => (object.scope === 'files' ? DENY : ALLOW),
      denials
    )
    const verdict = judge(filesDenied.gate)
    expect(verdict.allowed).toBe(false)
    expect(filesDenied.calls).toHaveLength(1)
    expect(filesDenied.calls[0].action).toBe('request')
    expect(filesDenied.calls[0].object).toEqual({
      type: 'request',
      method: 'GET',
      path: '/files/library',
      query,
      route: 'library',
      scope: 'files',
      access: 'read'
    })
    expect(denials.recent()).toMatchObject([
      { stage: 'request', summary: 'GET /files/library', scope: 'files' }
    ])

    const sessionsDenied = recordingGate((object) => (object.scope === 'sessions' ? DENY : ALLOW))
    expect(judge(sessionsDenied.gate).allowed).toBe(true)
  })
})

describe('PG-6 拒绝记录', () => {
  it('PG-6 放行不记；合并窗口；新 ID；上限；onChange', () => {
    let now = 1000
    const onChange = vi.fn()
    const warn = vi.fn()
    const denials = new NetworkDenialLog({ now: () => now, onChange, logger: { warn } })
    const { gate } = recordingGate((object) => (object.type === 'socket' ? ALLOW : DENY), denials)
    gate.judgeSocket(PEER)
    expect(denials.recent()).toEqual([])
    const fresh = httpFactsOf({ headers: {} })
    gate.judgeRequest(PEER, fresh, { method: 'GET', path: '/', query: {}, route: 'page' }, DEVICE)
    now += 1000
    gate.judgeRequest(PEER, fresh, { method: 'GET', path: '/', query: {}, route: 'page' }, DEVICE)
    expect(denials.recent()).toEqual([
      {
        at: 1000,
        lastAt: 2000,
        count: 2,
        stage: 'request',
        summary: 'GET /',
        scope: 'app',
        address: '192.168.1.23',
        device: DEVICE,
        rule: 'p#0',
        policies: ['P'],
        downgraded: false
      }
    ])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('network_denial request')
    now += NETWORK_DENIAL_WINDOW_MS
    gate.judgeRequest(PEER, fresh, { method: 'GET', path: '/', query: {}, route: 'page' }, DEVICE)
    expect(denials.recent()).toHaveLength(2)
    expect(onChange).toHaveBeenCalledTimes(2)
    for (let i = 0; i < MAX_NETWORK_DENIALS + 5; i++) {
      gate.judgeChannel(PEER, HTTP, 'ws:1', { channel: `c:${i}`, kind: 'send', size: 1, args: [] })
    }
    expect(denials.recent(1000)).toHaveLength(MAX_NETWORK_DENIALS)
    expect(denials.recent(1)[0].summary).toBe(`c:${MAX_NETWORK_DENIALS + 4}`)
  })
})

describe('PG-7 判定出错与没接上', () => {
  it('PG-7', () => {
    const warn = vi.fn()
    const denials = new NetworkDenialLog()
    const broken = new NetworkPolicyGate({
      contextFor: () => () => ({
        judgeGate: () => {
          throw new Error('boom')
        }
      }),
      denials,
      logger: { warn }
    })
    const verdict = broken.judgeSocket(PEER)
    expect(verdict.allowed).toBe(false)
    expect(verdict.decision.winning).toBe('error')
    expect(warn).toHaveBeenCalled()
    expect(denials.recent()[0]).toMatchObject({ stage: 'socket', rule: 'error' })

    const unwired = new NetworkPolicyGate({ contextFor: () => undefined, denials })
    expect(unwired.judgeSocket(PEER).allowed).toBe(true)
  })
})
