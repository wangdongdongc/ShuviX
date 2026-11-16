// @vitest-environment jsdom
/**
 * 侧栏视图的 store（会话 / 收件箱 / 日历；2026-11-16；jsdom）。
 *
 * 契约：初值在模块加载时从 `localStorage['shuvix.sidebarView']` 读，读不出、认不得的值回到 `sessions`
 * （不改写存储）；`setView` 先改状态再写存储，写不了也照样切。
 *
 * 初值在加载时读，所以每条用例 `vi.resetModules()` 后重新 `import()`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'shuvix.sidebarView'

type StoreModule = typeof import('../sidebarViewStore')

async function load(): Promise<StoreModule['useSidebarViewStore']> {
  vi.resetModules()
  return (await import('../sidebarViewStore')).useSidebarViewStore
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('sidebarViewStore: initial view', () => {
  it('VST-1 empty storage → sessions', async () => {
    const store = await load()
    expect(store.getState().view).toBe('sessions')
  })

  it.each([['sessions'], ['inbox'], ['calendar']])(
    'VST-2 stored %s is the initial view',
    async (v) => {
      window.localStorage.setItem(KEY, v)
      const store = await load()
      expect(store.getState().view).toBe(v)
    }
  )

  it.each([['widget'], ['INBOX'], [''], ['null'], ['{"view":"inbox"}']])(
    'VST-3 unknown stored %j → sessions, storage untouched',
    async (v) => {
      window.localStorage.setItem(KEY, v)
      const store = await load()
      expect(store.getState().view).toBe('sessions')
      expect(window.localStorage.getItem(KEY)).toBe(v)
    }
  )

  it('VST-4 getItem throws → sessions', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const store = await load()
    expect(store.getState().view).toBe('sessions')
  })

  it('VST-5 the localStorage getter itself throws → sessions; setView still switches', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      }
    })
    try {
      const store = await load()
      expect(store.getState().view).toBe('sessions')
      expect(() => store.getState().setView('inbox')).not.toThrow()
      expect(store.getState().view).toBe('inbox')
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
      else delete (window as unknown as Record<string, unknown>).localStorage
    }
  })
})

describe('sidebarViewStore: setView', () => {
  it('VST-6 writes state and the exact storage key', async () => {
    const store = await load()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    store.getState().setView('inbox')
    expect(store.getState().view).toBe('inbox')
    expect(setItem).toHaveBeenCalledWith('shuvix.sidebarView', 'inbox')
    expect(window.localStorage.getItem('shuvix.sidebarView')).toBe('inbox')
  })

  it('VST-7 state and storage follow each step; sessions is written, not removed', async () => {
    const store = await load()
    for (const v of ['inbox', 'calendar', 'sessions'] as const) {
      store.getState().setView(v)
      expect(store.getState().view).toBe(v)
      expect(window.localStorage.getItem(KEY)).toBe(v)
    }
  })

  it('VST-8 setItem throws → no throw, the view still changes', async () => {
    const store = await load()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => store.getState().setView('calendar')).not.toThrow()
    expect(store.getState().view).toBe('calendar')
  })

  it('VST-9 one notification per setView; the state is set before the write', async () => {
    const store = await load()
    const seen: string[] = []
    const off = store.subscribe((s) => seen.push(s.view))
    let viewAtWrite: string | null = null
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      viewAtWrite = store.getState().view
      throw new Error('quota')
    })
    store.getState().setView('inbox')
    expect(seen).toEqual(['inbox'])
    expect(viewAtWrite).toBe('inbox')
    store.getState().setView('calendar')
    expect(seen).toEqual(['inbox', 'calendar'])
    off()
  })

  it('VST-10 round trip across a reload', async () => {
    const first = await load()
    first.getState().setView('calendar')
    const second = await load()
    expect(second).not.toBe(first)
    expect(second.getState().view).toBe('calendar')
  })
})
