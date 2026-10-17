// @vitest-environment jsdom
/**
 * widgetStore —— Widget 面板的状态：列表重拉、点卡片开在哪（面板 / 独立窗口）、打开方式的记忆、
 * 面板里开着的应用。
 *
 * `window.api` 是假件（widget / widgetWindow 两块都是间谍）；`isWebHost` 在模块求值时定，所以每条用例
 * resetModules + doMock('../../host/hostMedia') 后重新导入 store（store 从空开始）。
 *
 *   ST-1  reload：面板里已删 / 已归档 / 开在独立窗口里的应用被收走，顺序不变；前台应用只在它被收走时清掉；
 *         status 问的是全部活跃 id
 *   ST-2  launchTarget：开着窗口 → window；上次选了窗口 → window；否则 panel；web 客户端恒为 panel
 *   ST-3  openInWindow（桌面）：setPreferWindow({id,value:true})；preferWindow 加上它且不重复；从面板收走、前台清掉；
 *         widgetWindow.open(id)；失败原样回 {success:false,error}。web：不记偏好，照样 open
 *   ST-3b focusWindow：不记偏好；从面板收走；open(id)；失败原样回
 *   ST-4  chooseOpenInPanel（桌面）：setPreferWindow(false)、从 preferWindow 拿掉；现问 status 说没开 → 不关；
 *         开着 → close(id) 再轮询到它关掉，windowOpen 里没了；一直关不掉 → 约 2s 后照样返回。web：不发任何 IPC
 *   ST-7  stopWidget / archiveWidget(id,true) / deleteWidget 在发 IPC 之前已从面板收走；archiveWidget(id,false) 不碰面板
 *   ST-8  openInPanel 两次不重复、切到前台；goHome 留着面板应用；关掉前台应用 → 回列表
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Store = (typeof import('../widgetStore'))['useWidgetStore']

function summary(id: string, over: Partial<WidgetSummary> = {}): WidgetSummary {
  return {
    id,
    name: id,
    description: '',
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 0,
    archivedAt: 0,
    ...over
  }
}

/** `window.api` 的假件（用 class 字段写，免得给工厂函数手写一大串返回类型） */
class FakeApi {
  app = { platform: 'darwin' }
  widget = {
    list: vi.fn(async (): Promise<WidgetSummary[]> => []),
    listArchived: vi.fn(async (): Promise<WidgetSummary[]> => []),
    getServerStatus: vi.fn(async () => ({
      running: false,
      port: 0,
      widgetCount: 0,
      registeredIds: [] as string[]
    })),
    stopWidget: vi.fn(async (_id: string) => ({ success: true })),
    rename: vi.fn(async () => ({ success: true })),
    setArchived: vi.fn(async (_p: { id: string; archived: boolean }) => ({ success: true })),
    delete: vi.fn(async (_id: string) => ({ success: true }))
  }
  widgetWindow = {
    status: vi.fn(async (_ids: string[]) => ({
      open: [] as string[],
      preferWindow: [] as string[]
    })),
    setPreferWindow: vi.fn(async (_p: { id: string; value: boolean }) => ({ success: true })),
    open: vi.fn(
      async (_id: string): Promise<{ success: boolean; error?: string }> => ({
        success: true
      })
    ),
    close: vi.fn(async (_id: string) => ({ success: true }))
  }
}

let api: FakeApi
let store: Store

async function load(web = false): Promise<Store> {
  vi.resetModules()
  vi.doMock('../../host/hostMedia', () => ({ isWebHost: web }))
  api = new FakeApi()
  if (web) api.app.platform = 'web'
  ;(window as unknown as { api: unknown }).api = api
  store = (await import('../widgetStore')).useWidgetStore
  return store
}

beforeEach(async () => {
  await load(false)
})

afterEach(() => {
  vi.useRealTimers()
  vi.doUnmock('../../host/hostMedia')
})

describe('reload（ST-1）', () => {
  it('ST-1 收走已删 / 已归档 / 开在窗口里的，顺序不变；前台还在就留着；status 问全部活跃 id', async () => {
    api.widget.list.mockResolvedValue(['a-a', 'b-b', 'c-c', 'e-e'].map((id) => summary(id)))
    api.widget.listArchived.mockResolvedValue([summary('d-d', { archivedAt: 5 })])
    api.widgetWindow.status.mockResolvedValue({ open: ['c-c'], preferWindow: ['b-b'] })
    store.setState({
      panelApps: ['e-e', 'gone-x', 'a-a', 'd-d', 'c-c'],
      foregroundApp: 'a-a'
    })

    await store.getState().reload()

    const s = store.getState()
    expect(s.panelApps).toEqual(['e-e', 'a-a'])
    expect(s.foregroundApp).toBe('a-a')
    expect(s.windowOpen).toEqual(['c-c'])
    expect(s.preferWindow).toEqual(['b-b'])
    expect(s.loaded).toBe(true)
    expect(api.widgetWindow.status).toHaveBeenCalledWith(['a-a', 'b-b', 'c-c', 'e-e'])
  })

  it('ST-1 前台应用被收走 → 回列表', async () => {
    api.widget.list.mockResolvedValue([summary('a-a'), summary('c-c')])
    api.widgetWindow.status.mockResolvedValue({ open: ['c-c'], preferWindow: [] })
    store.setState({ panelApps: ['a-a', 'c-c'], foregroundApp: 'c-c' })

    await store.getState().reload()

    expect(store.getState().panelApps).toEqual(['a-a'])
    expect(store.getState().foregroundApp).toBeNull()
  })

  it('ST-1 前台应用被删 → 回列表', async () => {
    api.widget.list.mockResolvedValue([summary('a-a')])
    store.setState({ panelApps: ['a-a', 'b-b'], foregroundApp: 'b-b' })
    await store.getState().reload()
    expect(store.getState().panelApps).toEqual(['a-a'])
    expect(store.getState().foregroundApp).toBeNull()
  })
})

describe('launchTarget（ST-2）', () => {
  it('ST-2 开着窗口 → window；上次选了窗口 → window；否则 panel', () => {
    store.setState({ windowOpen: ['a-a'], preferWindow: ['b-b'] })
    const { launchTarget } = store.getState()
    expect(launchTarget('a-a')).toBe('window')
    expect(launchTarget('b-b')).toBe('window')
    expect(launchTarget('c-c')).toBe('panel')
  })

  it('ST-2 web 客户端恒为 panel', async () => {
    await load(true)
    store.setState({ windowOpen: ['a-a'], preferWindow: ['b-b'] })
    expect(store.getState().launchTarget('a-a')).toBe('panel')
    expect(store.getState().launchTarget('b-b')).toBe('panel')
  })
})

describe('openInWindow（ST-3）', () => {
  it('ST-3 记偏好、preferWindow 不重复、从面板收走、前台清掉、开窗口', async () => {
    store.setState({ panelApps: ['a-a', 'b-b'], foregroundApp: 'a-a', preferWindow: [] })

    await expect(store.getState().openInWindow('a-a')).resolves.toEqual({ success: true })
    await store.getState().openInWindow('a-a')

    expect(api.widgetWindow.setPreferWindow).toHaveBeenCalledWith({ id: 'a-a', value: true })
    const s = store.getState()
    expect(s.preferWindow).toEqual(['a-a'])
    expect(s.panelApps).toEqual(['b-b'])
    expect(s.foregroundApp).toBeNull()
    expect(api.widgetWindow.open).toHaveBeenCalledWith('a-a')
  })

  it('ST-3 开窗失败 → 原样回 {success:false,error}', async () => {
    api.widgetWindow.open.mockResolvedValue({ success: false, error: 'is archived' })
    await expect(store.getState().openInWindow('a-a')).resolves.toEqual({
      success: false,
      error: 'is archived'
    })
  })

  it('ST-3 web：不记偏好，照样 open', async () => {
    await load(true)
    store.setState({ panelApps: ['a-a'], foregroundApp: 'a-a' })
    await expect(store.getState().openInWindow('a-a')).resolves.toEqual({ success: true })
    expect(api.widgetWindow.setPreferWindow).not.toHaveBeenCalled()
    expect(store.getState().preferWindow).toEqual([])
    expect(store.getState().panelApps).toEqual([])
    expect(api.widgetWindow.open).toHaveBeenCalledWith('a-a')
  })
})

describe('focusWindow（ST-3b）', () => {
  it('ST-3b 不记偏好；从面板收走；开窗口', async () => {
    store.setState({ panelApps: ['a-a', 'b-b'], foregroundApp: 'a-a', preferWindow: [] })
    await expect(store.getState().focusWindow('a-a')).resolves.toEqual({ success: true })
    expect(api.widgetWindow.setPreferWindow).not.toHaveBeenCalled()
    expect(store.getState().preferWindow).toEqual([])
    expect(store.getState().panelApps).toEqual(['b-b'])
    expect(store.getState().foregroundApp).toBeNull()
    expect(api.widgetWindow.open).toHaveBeenCalledWith('a-a')
  })

  it('ST-3b 失败原样回', async () => {
    api.widgetWindow.open.mockResolvedValue({ success: false, error: 'nope' })
    await expect(store.getState().focusWindow('a-a')).resolves.toEqual({
      success: false,
      error: 'nope'
    })
  })
})

describe('chooseOpenInPanel（ST-4）', () => {
  it('ST-4 记偏好 false、拿掉 preferWindow；现问说没开 → 不关', async () => {
    store.setState({ preferWindow: ['a-a', 'b-b'], windowOpen: ['a-a'] }) // 缓存说开着，现问说没开
    api.widgetWindow.status.mockResolvedValue({ open: [], preferWindow: [] })

    await store.getState().chooseOpenInPanel('a-a')

    expect(api.widgetWindow.setPreferWindow).toHaveBeenCalledWith({ id: 'a-a', value: false })
    expect(store.getState().preferWindow).toEqual(['b-b'])
    expect(api.widgetWindow.status).toHaveBeenCalledWith([])
    expect(api.widgetWindow.close).not.toHaveBeenCalled()
  })

  it('ST-4 现问说开着（缓存还没跟上）→ close 再轮询到关掉，windowOpen 里没了', async () => {
    store.setState({ windowOpen: [] })
    api.widgetWindow.status
      .mockResolvedValueOnce({ open: ['a-a'], preferWindow: [] })
      .mockResolvedValueOnce({ open: ['a-a'], preferWindow: [] })
      .mockResolvedValue({ open: [], preferWindow: [] })
    store.setState({ windowOpen: ['a-a', 'b-b'] })

    await store.getState().chooseOpenInPanel('a-a')

    expect(api.widgetWindow.close).toHaveBeenCalledWith('a-a')
    expect(api.widgetWindow.status).toHaveBeenCalledTimes(3)
    expect(store.getState().windowOpen).toEqual(['b-b'])
  })

  it('ST-4 一直关不掉 → 约 2s 后照样返回', async () => {
    vi.useFakeTimers()
    api.widgetWindow.status.mockResolvedValue({ open: ['a-a'], preferWindow: [] })
    store.setState({ windowOpen: ['a-a'] })
    let done = false
    const p = store
      .getState()
      .chooseOpenInPanel('a-a')
      .then(() => {
        done = true
      })

    await vi.advanceTimersByTimeAsync(1900)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(done).toBe(true)
    await p
    expect(api.widgetWindow.close).toHaveBeenCalledWith('a-a')
    expect(store.getState().windowOpen).toEqual([])
  })

  it('ST-4 web：不发任何 IPC', async () => {
    await load(true)
    store.setState({ preferWindow: ['a-a'] })
    await store.getState().chooseOpenInPanel('a-a')
    expect(api.widgetWindow.setPreferWindow).not.toHaveBeenCalled()
    expect(api.widgetWindow.status).not.toHaveBeenCalled()
    expect(api.widgetWindow.close).not.toHaveBeenCalled()
  })
})

describe('停止 / 归档 / 删除（ST-7）', () => {
  beforeEach(() => {
    api.widget.list.mockResolvedValue([summary('a-a'), summary('b-b')])
    store.setState({ panelApps: ['a-a', 'b-b'], foregroundApp: 'a-a' })
  })

  const panelAtCall = (): string[] => [...store.getState().panelApps]

  it('ST-7 stopWidget：发 IPC 前已从面板收走', async () => {
    let seen: string[] = []
    api.widget.stopWidget.mockImplementation(async () => {
      seen = panelAtCall()
      return { success: true }
    })
    await store.getState().stopWidget('a-a')
    expect(seen).toEqual(['b-b'])
    expect(api.widget.stopWidget).toHaveBeenCalledWith('a-a')
    expect(store.getState().foregroundApp).toBeNull()
  })

  it('ST-7 archiveWidget(id,true)：发 IPC 前已从面板收走', async () => {
    let seen: string[] = []
    api.widget.setArchived.mockImplementation(async () => {
      seen = panelAtCall()
      return { success: true }
    })
    await store.getState().archiveWidget('a-a', true)
    expect(seen).toEqual(['b-b'])
    expect(api.widget.setArchived).toHaveBeenCalledWith({ id: 'a-a', archived: true })
  })

  it('ST-7 deleteWidget：发 IPC 前已从面板收走', async () => {
    let seen: string[] = []
    api.widget.delete.mockImplementation(async () => {
      seen = panelAtCall()
      return { success: true }
    })
    await store.getState().deleteWidget('b-b')
    expect(seen).toEqual(['a-a'])
    expect(api.widget.delete).toHaveBeenCalledWith('b-b')
  })

  it('ST-7 archiveWidget(id,false) 不碰面板', async () => {
    let seen: string[] = []
    api.widget.setArchived.mockImplementation(async () => {
      seen = panelAtCall()
      return { success: true }
    })
    await store.getState().archiveWidget('a-a', false)
    expect(seen).toEqual(['a-a', 'b-b'])
    expect(store.getState().panelApps).toEqual(['a-a', 'b-b'])
    expect(store.getState().foregroundApp).toBe('a-a')
  })
})

describe('面板里的应用（ST-8）', () => {
  it('ST-8 openInPanel 两次不重复、切到前台', () => {
    store.getState().openInPanel('a-a')
    store.getState().openInPanel('b-b')
    store.getState().openInPanel('a-a')
    expect(store.getState().panelApps).toEqual(['a-a', 'b-b'])
    expect(store.getState().foregroundApp).toBe('a-a')
  })

  it('ST-8 goHome 留着面板应用', () => {
    store.getState().openInPanel('a-a')
    store.getState().goHome()
    expect(store.getState().foregroundApp).toBeNull()
    expect(store.getState().panelApps).toEqual(['a-a'])
  })

  it('ST-8 关掉前台应用 → 回列表；关后台的不动前台', () => {
    store.getState().openInPanel('a-a')
    store.getState().openInPanel('b-b')
    store.getState().closePanelApp('a-a')
    expect(store.getState().foregroundApp).toBe('b-b')
    store.getState().closePanelApp('b-b')
    expect(store.getState().foregroundApp).toBeNull()
    expect(store.getState().panelApps).toEqual([])
  })
})
