/**
 * `web/webApi.ts` 与 `web/webNotices.ts`（server mode phase C）—— 浏览器里的 `window.api`：两条本地实现的通道（设置在新标签页、
 * 外链只放 http / https / mailto）、本地当场拒绝的桌面专属通道、由连接建出的 api；以及「桌面专属」提示的小仓库。
 * 浏览器是假的 `fakeWin`（`location` + `open` spy）。
 *
 *   WA-1 app:open-settings：`#settings/<tab>`（带上当前 pathname），没给 / 空 / 非字符串 → `#settings`；回 {success:true}
 *   WA-2 app:open-external：http / https / mailto 用归一后的 href 在新标签页（noopener,noreferrer）开、回 {success:true}；
 *        javascript / file / data / ftp / 自定义协议 / 不是 URL / 空 / undefined → {success:false}，open 不调
 *   WA-3 webDesktopOnlyChannels：桌面专属表减去本地实现（剩 5 条：悬浮窗两条、内置浏览器窗口与它的设置页、保存框）；
 *        {} → 19；只认自有属性
 *   WA-4 本地实现的每个键都是桌面专属键、也是通道表里的 invoke 通道（服务端反正会拒它们）
 *   WA-5 createWebApi：platform 'web'、sync 的成员就是连接 sync 的那几个函数；命名空间 = 表 + events / liveDoc / knowledge / sync；
 *        liveDoc.respond / knowledge.baseOptions 的打包；两次 events.subscribe 只挂一个 app:event 监听
 *   WN-1 webNotices：起初 null；notifyDesktopOnly 记一条（id 递增，同一通道也是新的一条）；订阅者每次都调、注销后不调；
 *        派发途中注销别人不打断这一轮
 *
 * phase D 的本地实现（docs/server/phase-d-web-fallbacks.md §D3）—— 依赖（invoke / showPath / pickDirectory）注入假的：
 *
 *   WA-6  files:open：合法 → true、新标签页开 filePreviewPageUrl（恰一次）；openedBy 只认 agent，别的都是 user；缺 / 空 /
 *         非字符串的 sessionId / path、参数是 undefined → false，不开
 *   WA-7  widgetWindow:open：'demo-widget' → {success:true}、新标签页开 widgetPageUrl；空 / undefined / 非字符串 →
 *         {success:false, error:'missing widget id'}，不开
 *   WA-8  注入的 pickDirectory：dialog:openDirectory 回字符串或 null；skill:pickExternalDir → {success:true,path} /
 *         {success:false,reason:'canceled'}
 *   WA-9  注入的 showPath：app:open-folder → 目录卡；app:reveal-path → 文件卡；空 / undefined → {success:false}、不显示；
 *         widget:revealExport('') → {success:true}（与桌面一样从不失败）、不显示；给了路径 → 文件卡
 *   WA-10 注入的 invoke：每条 *:openFolder → 先 fs:locateFolder({kind})（WEB_FOLDER_CHANNELS 的 kind）再显示目录卡；
 *         回包没有可用的路径（null / '' / {} / undefined / 非字符串）→ {success:false}、不显示；没给 invoke → {success:false}；
 *         knowledge:revealFile → fs:locateFolder({kind:'knowledgeEntry', path}) 再显示文件卡，空条目 → {success:false} 不问；
 *         invoke 拒绝 → 照样 resolve {success:false}、不显示（从不拒绝）
 *   WA-11 缺省依赖（resetModules）：app:open-folder 的卡片进 webPathNotice；dialog:openDirectory 挂起一次 webDirectoryPick，
 *         settle 之后 resolve 那个路径
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TABLE, DESKTOP_ONLY_CHANNELS } from '../../../../shared/apiTable'
import type { ApiTransport } from '../../../../shared/buildApi'
import { filePreviewPageUrl, widgetPageUrl } from '../../host/hostUrls'
import {
  WEB_FOLDER_CHANNELS,
  createWebApi,
  webDesktopOnlyChannels,
  webLocalHandlers
} from '../webApi'
import type { WsConnection } from '../wsConnection'

let fakeWin: {
  location: { origin: string; pathname: string }
  open: ReturnType<typeof vi.fn<(url: string, target?: string, features?: string) => unknown>>
}

beforeEach(() => {
  fakeWin = {
    location: { origin: 'http://192.168.1.10:7766', pathname: '/' },
    open: vi.fn<(url: string, target?: string, features?: string) => unknown>()
  }
})

describe('WA-1 app:open-settings', () => {
  it('WA-1 #settings/<tab>；回 {success:true}', () => {
    const local = webLocalHandlers(fakeWin)
    expect(local['app:open-settings']('general')).toStrictEqual({ success: true })
    expect(fakeWin.open).toHaveBeenCalledWith(
      'http://192.168.1.10:7766/#settings/general',
      '_blank'
    )
  })

  it('WA-1 带上当前 pathname', () => {
    fakeWin.location.pathname = '/web.html'
    webLocalHandlers(fakeWin)['app:open-settings']('general')
    expect(fakeWin.open).toHaveBeenCalledWith(
      'http://192.168.1.10:7766/web.html#settings/general',
      '_blank'
    )
  })

  it('WA-1 没给 / 空 / 非字符串 → #settings', () => {
    const local = webLocalHandlers(fakeWin)
    for (const tab of [undefined, '', 5]) {
      fakeWin.open.mockClear()
      expect(local['app:open-settings'](tab)).toStrictEqual({ success: true })
      expect(fakeWin.open).toHaveBeenCalledWith('http://192.168.1.10:7766/#settings', '_blank')
    }
  })
})

describe('WA-2 app:open-external', () => {
  it('WA-2 http / https / mailto：新标签页开归一后的 href', () => {
    const open = webLocalHandlers(fakeWin)['app:open-external']
    expect(open('https://example.com/a?b')).toStrictEqual({ success: true })
    expect(fakeWin.open).toHaveBeenLastCalledWith(
      'https://example.com/a?b',
      '_blank',
      'noopener,noreferrer'
    )
    expect(open('http://example.com/')).toStrictEqual({ success: true })
    expect(open('mailto:a@b.c')).toStrictEqual({ success: true })
    expect(fakeWin.open).toHaveBeenLastCalledWith('mailto:a@b.c', '_blank', 'noopener,noreferrer')
    expect(open('HTTPS://EXAMPLE.com')).toStrictEqual({ success: true })
    expect(fakeWin.open).toHaveBeenLastCalledWith(
      'https://example.com/',
      '_blank',
      'noopener,noreferrer'
    )
  })

  it('WA-2 别的协议 / 不是 URL → {success:false}，open 不调', () => {
    const open = webLocalHandlers(fakeWin)['app:open-external']
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'ftp://x',
      'shuvix-lib://x',
      'not a url',
      '',
      undefined
    ]) {
      expect(open(url), String(url)).toStrictEqual({ success: false })
    }
    expect(fakeWin.open).not.toHaveBeenCalled()
  })
})

describe('WA-3 webDesktopOnlyChannels', () => {
  it('WA-3 减去本地实现：剩 5 条', () => {
    const set = webDesktopOnlyChannels(webLocalHandlers(fakeWin))
    expect([...set].sort()).toStrictEqual(
      [
        'browser-view:open-settings',
        'browser-view:open-window',
        'pinChat:focus',
        'pinChat:pin',
        'widget:pickExportTarget'
      ].sort()
    )
    expect(set.has('app:open-folder')).toBe(false)
    expect(set.has('files:open')).toBe(false)
    expect(set.has('app:open-settings')).toBe(false)
    expect(set.has('app:open-external')).toBe(false)
  })

  it('WA-3 {} → 20；只认自有属性', () => {
    expect(webDesktopOnlyChannels({}).size).toBe(20)
    const inherited = webDesktopOnlyChannels(Object.create({ 'app:open-folder': () => {} }))
    expect(inherited.has('app:open-folder')).toBe(true)
    expect(inherited.size).toBe(20)
  })
})

describe('WA-4 本地实现的通道', () => {
  it('WA-4 每个键都是桌面专属键与 invoke 通道', () => {
    const invokeChannels = new Set<string>()
    for (const ns of Object.values(API_TABLE)) {
      for (const member of Object.values(ns)) {
        if (member.kind === 'invoke') invokeChannels.add(member.channel)
      }
    }
    const keys = Object.keys(webLocalHandlers(fakeWin))
    expect(keys.sort()).toStrictEqual(
      [
        'app:open-external',
        'app:open-folder',
        'app:open-settings',
        'app:reveal-path',
        'bot:openFolder',
        'dialog:openDirectory',
        'files:open',
        'hook:openFolder',
        'knowledge:openFolder',
        'knowledge:revealFile',
        'policy:openFolder',
        'skill:pickExternalDir',
        'subAgent:openFolder',
        'widget:revealExport',
        'widgetWindow:open'
      ].sort()
    )
    for (const key of keys) {
      expect(Object.hasOwn(DESKTOP_ONLY_CHANNELS, key), key).toBe(true)
      expect(invokeChannels.has(key), key).toBe(true)
    }
  })
})

describe('WA-5 createWebApi', () => {
  function fakeConnection(): {
    conn: WsConnection
    invoke: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
  } {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve('r'))
    const on = vi.fn((_channel: string, _listener: (...payload: unknown[]) => void) => () => {})
    const transport: ApiTransport = {
      invoke: (channel, ...args) => invoke(channel, ...args),
      send: vi.fn(),
      on: (channel, listener) => on(channel, listener)
    }
    const sync = {
      send: vi.fn(),
      onFrame: vi.fn(() => () => {}),
      onDown: vi.fn(() => () => {}),
      onUp: vi.fn(() => () => {}),
      isUp: () => true
    }
    const conn: WsConnection = {
      transport,
      sync,
      state: () => 'open',
      onState: () => () => {},
      dispose: () => {}
    }
    return { conn, invoke, on }
  }

  it("WA-5 platform 'web'、sync 原样、命名空间", () => {
    const { conn } = fakeConnection()
    const api = createWebApi(conn)
    expect(api.app.platform).toBe('web')
    // buildApi 把 override 的成员并进一个新的命名空间对象：成员就是连接的那几个函数
    for (const key of Object.keys(conn.sync) as Array<keyof typeof conn.sync>) {
      expect(api.sync[key], key).toBe(conn.sync[key])
    }
    expect(Object.keys(api.sync).sort()).toStrictEqual(Object.keys(conn.sync).sort())
    const expected = new Set([...Object.keys(API_TABLE), 'events', 'liveDoc', 'knowledge', 'sync'])
    expect(new Set(Object.keys(api))).toStrictEqual(expected)
  })

  it('WA-5 liveDoc.respond / knowledge.baseOptions 的打包；只挂一个 app:event 监听', async () => {
    const { conn, invoke, on } = fakeConnection()
    const api = createWebApi(conn)
    const res = { ok: true, text: 't' }
    await api.liveDoc.respond('r1', res as never)
    expect(invoke).toHaveBeenLastCalledWith('liveDoc:respond', { requestId: 'r1', result: res })
    await api.knowledge.baseOptions()
    expect(invoke).toHaveBeenLastCalledWith('knowledge:baseOptions', {})
    api.events.subscribe(() => {})
    api.events.subscribe(() => {})
    expect(on.mock.calls.filter(([channel]) => channel === 'app:event')).toHaveLength(1)
  })
})

describe('WN-1 webNotices', () => {
  it('WN-1 起初 null；id 递增；订阅 / 注销；派发途中注销别人不打断', async () => {
    vi.resetModules()
    const notices = await import('../webNotices')
    expect(notices.currentNotice()).toBeNull()

    const a = vi.fn()
    const offA = notices.subscribeNotice(a)
    notices.notifyDesktopOnly('a')
    expect(notices.currentNotice()).toStrictEqual({ id: 1, channel: 'a' })
    notices.notifyDesktopOnly('a')
    expect(notices.currentNotice()).toStrictEqual({ id: 2, channel: 'a' })
    expect(a).toHaveBeenCalledTimes(2)
    offA()
    notices.notifyDesktopOnly('b')
    expect(a).toHaveBeenCalledTimes(2)
    expect(notices.currentNotice()).toStrictEqual({ id: 3, channel: 'b' })

    const c = vi.fn()
    let offC: () => void = () => {}
    const b = vi.fn(() => offC())
    notices.subscribeNotice(b)
    offC = notices.subscribeNotice(c)
    const d = vi.fn()
    notices.subscribeNotice(d)
    expect(() => notices.notifyDesktopOnly('c')).not.toThrow()
    expect(b).toHaveBeenCalledTimes(1)
    expect(d).toHaveBeenCalledTimes(1)
    const cAfterFirstRound = c.mock.calls.length
    notices.notifyDesktopOnly('d')
    expect(b).toHaveBeenCalledTimes(2)
    expect(d).toHaveBeenCalledTimes(2)
    // c 在第一轮里被注销：第二轮起不再调
    expect(c).toHaveBeenCalledTimes(cAfterFirstRound)
  })
})

describe('WA-6 files:open', () => {
  it('WA-6 合法 → true，新标签页开预览那一屏（恰一次）', () => {
    const open = webLocalHandlers(fakeWin)['files:open']
    expect(open({ sessionId: 's1', path: '/a b/c.png' })).toBe(true)
    expect(fakeWin.open).toHaveBeenCalledTimes(1)
    expect(fakeWin.open).toHaveBeenCalledWith(
      filePreviewPageUrl(fakeWin.location, {
        sessionId: 's1',
        path: '/a b/c.png',
        openedBy: 'user'
      }),
      '_blank'
    )
  })

  it("WA-6 openedBy 只认 'agent'，别的都是 user", () => {
    const open = webLocalHandlers(fakeWin)['files:open']
    expect(open({ sessionId: 's1', path: '/a.md', openedBy: 'agent' })).toBe(true)
    expect(fakeWin.open).toHaveBeenLastCalledWith(
      filePreviewPageUrl(fakeWin.location, { sessionId: 's1', path: '/a.md', openedBy: 'agent' }),
      '_blank'
    )
    for (const openedBy of ['user', 'Agent', 'x', undefined, 1]) {
      expect(open({ sessionId: 's1', path: '/a.md', openedBy })).toBe(true)
      expect(fakeWin.open, String(openedBy)).toHaveBeenLastCalledWith(
        filePreviewPageUrl(fakeWin.location, { sessionId: 's1', path: '/a.md', openedBy: 'user' }),
        '_blank'
      )
    }
  })

  it('WA-6 缺 / 空 / 非字符串的 sessionId 或 path、参数 undefined → false，不开', () => {
    const open = webLocalHandlers(fakeWin)['files:open']
    for (const params of [
      undefined,
      {},
      { path: '/a.png' },
      { sessionId: 's1' },
      { sessionId: '', path: '/a.png' },
      { sessionId: 's1', path: '' },
      { sessionId: 5, path: '/a.png' },
      { sessionId: 's1', path: ['/a.png'] }
    ]) {
      expect(open(params), JSON.stringify(params)).toBe(false)
    }
    expect(fakeWin.open).not.toHaveBeenCalled()
  })
})

describe('WA-7 widgetWindow:open', () => {
  it('WA-7 合法 → {success:true}，新标签页开 widget 那一屏', () => {
    const open = webLocalHandlers(fakeWin)['widgetWindow:open']
    expect(open('demo-widget')).toStrictEqual({ success: true })
    expect(fakeWin.open).toHaveBeenCalledTimes(1)
    expect(fakeWin.open).toHaveBeenCalledWith(
      widgetPageUrl(fakeWin.location, 'demo-widget'),
      '_blank'
    )
  })

  it("WA-7 空 / undefined / 非字符串 → {success:false, error:'missing widget id'}，不开", () => {
    const open = webLocalHandlers(fakeWin)['widgetWindow:open']
    for (const id of ['', undefined, 5]) {
      expect(open(id), String(id)).toStrictEqual({ success: false, error: 'missing widget id' })
    }
    expect(fakeWin.open).not.toHaveBeenCalled()
  })
})

describe('WA-8 选目录', () => {
  it('WA-8 dialog:openDirectory 回选中的路径或 null', async () => {
    const pickDirectory = vi.fn<() => Promise<string | null>>()
    const local = webLocalHandlers(fakeWin, { pickDirectory })
    pickDirectory.mockResolvedValueOnce('/srv/proj')
    await expect(local['dialog:openDirectory']()).resolves.toBe('/srv/proj')
    pickDirectory.mockResolvedValueOnce(null)
    await expect(local['dialog:openDirectory']()).resolves.toBeNull()
    expect(pickDirectory).toHaveBeenCalledTimes(2)
  })

  it("WA-8 skill:pickExternalDir → {success:true,path} / {success:false,reason:'canceled'}", async () => {
    const pickDirectory = vi.fn<() => Promise<string | null>>()
    const local = webLocalHandlers(fakeWin, { pickDirectory })
    pickDirectory.mockResolvedValueOnce('/srv/skills')
    await expect(local['skill:pickExternalDir']()).resolves.toStrictEqual({
      success: true,
      path: '/srv/skills'
    })
    pickDirectory.mockResolvedValueOnce(null)
    await expect(local['skill:pickExternalDir']()).resolves.toStrictEqual({
      success: false,
      reason: 'canceled'
    })
  })
})

describe('WA-9 显示已知的路径', () => {
  it('WA-9 app:open-folder → 目录卡；app:reveal-path → 文件卡', () => {
    const showPath = vi.fn()
    const local = webLocalHandlers(fakeWin, { showPath })
    expect(local['app:open-folder']('/x')).toStrictEqual({ success: true })
    expect(showPath).toHaveBeenLastCalledWith({
      channel: 'app:open-folder',
      path: '/x',
      target: 'folder'
    })
    expect(local['app:reveal-path']('/x/f.txt')).toStrictEqual({ success: true })
    expect(showPath).toHaveBeenLastCalledWith({
      channel: 'app:reveal-path',
      path: '/x/f.txt',
      target: 'file'
    })
    expect(showPath).toHaveBeenCalledTimes(2)
  })

  it('WA-9 空 / undefined → {success:false}，不显示', () => {
    const showPath = vi.fn()
    const local = webLocalHandlers(fakeWin, { showPath })
    for (const channel of ['app:open-folder', 'app:reveal-path']) {
      for (const path of ['', undefined, 5]) {
        expect(local[channel](path), `${channel} ${String(path)}`).toStrictEqual({ success: false })
      }
    }
    expect(showPath).not.toHaveBeenCalled()
  })

  it("WA-9 widget:revealExport：'' → {success:true}、不显示；给了路径 → 文件卡", () => {
    const showPath = vi.fn()
    const local = webLocalHandlers(fakeWin, { showPath })
    expect(local['widget:revealExport']('')).toStrictEqual({ success: true })
    expect(showPath).not.toHaveBeenCalled()
    expect(local['widget:revealExport']('/u/widget-exports/export-1/demo.zip')).toStrictEqual({
      success: true
    })
    expect(showPath).toHaveBeenCalledWith({
      channel: 'widget:revealExport',
      path: '/u/widget-exports/export-1/demo.zip',
      target: 'file'
    })
  })
})

describe('WA-10 先问服务端再显示', () => {
  it('WA-10 每条 *:openFolder：fs:locateFolder({kind}) 再显示目录卡', async () => {
    expect(WEB_FOLDER_CHANNELS).toStrictEqual({
      'subAgent:openFolder': 'agents',
      'policy:openFolder': 'policies',
      'hook:openFolder': 'hooks',
      'bot:openFolder': 'bots',
      'knowledge:openFolder': 'knowledge'
    })
    for (const [channel, kind] of Object.entries(WEB_FOLDER_CHANNELS)) {
      const invoke = vi.fn(async () => ({ path: `/srv/${kind}` }))
      const showPath = vi.fn()
      const local = webLocalHandlers(fakeWin, { invoke, showPath })
      await expect(local[channel](), channel).resolves.toStrictEqual({ success: true })
      expect(invoke, channel).toHaveBeenCalledTimes(1)
      expect(invoke, channel).toHaveBeenCalledWith('fs:locateFolder', { kind })
      expect(showPath, channel).toHaveBeenCalledTimes(1)
      expect(showPath, channel).toHaveBeenCalledWith({
        channel,
        path: `/srv/${kind}`,
        target: 'folder'
      })
    }
  })

  it('WA-10 回包没有可用的路径 → {success:false}，不显示', async () => {
    for (const reply of [{ path: null }, { path: '' }, {}, undefined, { path: 5 }]) {
      const invoke = vi.fn(async () => reply)
      const showPath = vi.fn()
      const local = webLocalHandlers(fakeWin, { invoke, showPath })
      await expect(local['policy:openFolder'](), JSON.stringify(reply)).resolves.toStrictEqual({
        success: false
      })
      expect(showPath, JSON.stringify(reply)).not.toHaveBeenCalled()
    }
  })

  it('WA-10 没给 invoke → {success:false}，不显示', async () => {
    const showPath = vi.fn()
    const local = webLocalHandlers(fakeWin, { showPath })
    await expect(local['hook:openFolder']()).resolves.toStrictEqual({ success: false })
    await expect(
      local['knowledge:revealFile']({ path: 'knowledge/n/a.md' })
    ).resolves.toStrictEqual({ success: false })
    expect(showPath).not.toHaveBeenCalled()
  })

  it('WA-10 knowledge:revealFile：问条目的路径再显示文件卡；空条目 → {success:false} 不问', async () => {
    const invoke = vi.fn(async () => ({ path: '/home/u/.shuvix/knowledge/n/a.md' }))
    const showPath = vi.fn()
    const local = webLocalHandlers(fakeWin, { invoke, showPath })
    await expect(
      local['knowledge:revealFile']({ path: 'knowledge/n/a.md' })
    ).resolves.toStrictEqual({
      success: true
    })
    expect(invoke).toHaveBeenCalledWith('fs:locateFolder', {
      kind: 'knowledgeEntry',
      path: 'knowledge/n/a.md'
    })
    expect(showPath).toHaveBeenCalledWith({
      channel: 'knowledge:revealFile',
      path: '/home/u/.shuvix/knowledge/n/a.md',
      target: 'file'
    })

    invoke.mockClear()
    showPath.mockClear()
    for (const params of [{ path: '' }, {}, undefined, { path: 5 }]) {
      await expect(
        local['knowledge:revealFile'](params),
        JSON.stringify(params)
      ).resolves.toStrictEqual({ success: false })
    }
    expect(invoke).not.toHaveBeenCalled()
    expect(showPath).not.toHaveBeenCalled()
  })

  it('WA-10 invoke 拒绝 → 照样 resolve {success:false}，不显示', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('disconnected')
    })
    const showPath = vi.fn()
    const local = webLocalHandlers(fakeWin, { invoke, showPath })
    for (const channel of Object.keys(WEB_FOLDER_CHANNELS)) {
      await expect(local[channel](), channel).resolves.toStrictEqual({ success: false })
    }
    await expect(
      local['knowledge:revealFile']({ path: 'knowledge/n/a.md' })
    ).resolves.toStrictEqual({ success: false })
    expect(invoke).toHaveBeenCalledTimes(Object.keys(WEB_FOLDER_CHANNELS).length + 1)
    expect(showPath).not.toHaveBeenCalled()
  })
})

describe('WA-11 缺省依赖', () => {
  it('WA-11 app:open-folder 的卡片进 webPathNotice；dialog:openDirectory 挂起一次选择，settle 之后 resolve', async () => {
    vi.resetModules()
    const web = await import('../webApi')
    const notices = await import('../webPathNotice')
    const picks = await import('../webDirectoryPick')
    const local = web.webLocalHandlers(fakeWin)

    expect(local['app:open-folder']('/x')).toStrictEqual({ success: true })
    expect(notices.currentServerPath()).toStrictEqual({
      id: 1,
      channel: 'app:open-folder',
      path: '/x',
      target: 'folder'
    })

    expect(picks.currentDirectoryPick()).toBeNull()
    const picked = local['dialog:openDirectory']() as Promise<string | null>
    const request = picks.currentDirectoryPick()
    expect(request).not.toBeNull()
    picks.settleDirectoryPick(request!.id, '/p')
    await expect(picked).resolves.toBe('/p')
    expect(picks.currentDirectoryPick()).toBeNull()
  })
})
