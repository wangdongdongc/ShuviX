// @vitest-environment jsdom
/**
 * 手机布局的文件页（mobile/MobileFilesPage.tsx，jsdom）。
 *
 * 契约：一页是工作目录里的一层 —— `files.scanDir({ sessionId, dir, stat: true })` 扫这一层；大标题是这一层的
 * 文件夹名（最上面一层是工作目录的名字），更深的层下面一行小字写相对路径；文件夹在前、文件在后，都在一张卡片里。
 * 点文件夹 → `onOpenDir`，点文件 → 预览信号（绝对路径）。文件一行两排：名字，下面「大小 · 修改时刻」（没有 stat
 * 就没有第二排）。以点开头的默认不列（这台设备上记着，「⋯」里切换）。只认最新一次扫描的结果；刷新失败留着原来的
 * 列表。跟着 `files.changed`（根 = 这一页自己扫出来的那个，还没扫到认会话的工作目录）合并 300ms 重扫，并把搜索用
 * 的全量清单作废。搜索框：停笔 250ms 全量 `files.scan` 一次，之后按路径过滤（searchFiles）；取不到是「出错」而不是
 * 「没找到」。长按一行是菜单：打开 / 在对话中引用（输入框是这条会话的才有）/ 复制路径 / 复制相对路径。
 *
 *   MF-1..6    加载与框架、行、点一行
 *   MF-7..10   隐藏文件
 *   MF-11..14  空 / 出错 / 刷新 / 只认最新一次扫描
 *   MF-15..16  files.changed
 *   MF-17..21  搜索
 *   MF-22      底部那一行
 *   MF-23..27  行的菜单
 *
 * `@shuvix/chat-ui` / `@shuvix/app-shell` 换成替身：chat store 是工厂里建的真 zustand store，路径工具是按源码路径
 * 引的真函数，`listTimeLabel` 交回固定的字；MobilePage、PullDownMenu、panelPure 是真的。真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

interface ScanDirResult {
  root: string | null
  dirs: string[]
  files: string[]
  stats?: Record<string, { size: number; mtime: number }>
}
interface ScanResult {
  paths: string[]
  truncated: boolean
  root: string | null
}
interface Deferred<T> {
  params: unknown
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}
interface MenuItem {
  id?: string
  label?: string
  type?: string
}
interface ChatState {
  projectPath: string | null
  composerSessionId: string | null
  requestFilePreview: (path: string) => void
  requestMentionInsert: (...args: unknown[]) => void
}
interface StoreApi {
  getState: () => ChatState
  setState: (patch: Partial<ChatState>) => void
}

const rec = vi.hoisted(() => ({
  store: null as unknown as StoreApi,
  scanDirs: [] as Array<Deferred<ScanDirResult>>,
  scans: [] as Array<Deferred<ScanResult>>,
  handlers: {} as Record<string, (event: Record<string, unknown>) => void>,
  menus: [] as Array<{ items: MenuItem[]; pick: (id: string) => void }>,
  copied: [] as string[]
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { create } = await import('zustand')
  const useChatStore = create<ChatState>(() => ({
    projectPath: null,
    composerSessionId: null,
    requestFilePreview: () => {},
    requestMentionInsert: () => {}
  }))
  rec.store = useChatStore as unknown as StoreApi
  const defer = <T>(list: Array<Deferred<T>>, params: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      list.push({ params, resolve, reject })
    })
  return {
    useChatStore,
    copyToClipboard: (text: string) => {
      rec.copied.push(text)
    },
    getSessionChannelApi: () => ({
      files: {
        scanDir: (params: unknown) => defer(rec.scanDirs, params),
        scan: (params: unknown) => defer(rec.scans, params)
      }
    }),
    useAppEvent: (type: string, handler: (event: Record<string, unknown>) => void) => {
      rec.handlers[type] = handler
    },
    isTaskFinished: () => false
  }
})

vi.mock('@shuvix/app-shell', async () => {
  const paths = await import('../../../../../../../packages/app-shell/src/files/paths')
  return {
    basename: paths.basename,
    joinPath: paths.joinPath,
    listTimeLabel: (ms: number) => `T${ms}`,
    useContextMenu:
      () =>
      (_e: unknown, items: MenuItem[], pick: (id: string) => void): Promise<void> => {
        rec.menus.push({ items, pick })
        return Promise.resolve()
      }
  }
})

import { MobileFilesPage, type MobileFilesPageProps } from '../MobileFilesPage'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const M = en.mobile
const P = en.panel
const HIDDEN_KEY = 'shuvix.mobileFiles.showHidden'
const ROOT = '/work/proj'

const onBack = vi.fn<() => void>()
const onOpenDir = vi.fn<(dir: string) => void>()
const onMentionInserted = vi.fn<() => void>()
const requestFilePreview = vi.fn<(path: string) => void>()
const requestMentionInsert = vi.fn<(...args: unknown[]) => void>()

let container: HTMLDivElement
let root: Root
let mounted = false

const listing = (over: Partial<ScanDirResult> = {}): ScanDirResult => ({
  root: ROOT,
  dirs: ['.git2/', 'src/'],
  files: ['.env', 'a.txt', 'b.bin'],
  stats: { 'a.txt': { size: 1536, mtime: 1000 } },
  ...over
})

function mount(over: Partial<MobileFilesPageProps> = {}): void {
  act(() =>
    root.render(
      createElement(MobileFilesPage, {
        sessionId: 's1',
        dir: '',
        backLabel: 'Chat',
        onBack,
        onOpenDir,
        onMentionInserted,
        ...over
      })
    )
  )
  mounted = true
}
function unmount(): void {
  if (!mounted) return
  act(() => root.unmount())
  mounted = false
}
/** 让已经落定的 promise 的后续跑完 */
const flush = (): Promise<void> => act(async () => {})
/** 第 n 次（缺省最新一次）扫这一层的结果到了 */
async function answerDir(
  result: ScanDirResult | Error,
  index = rec.scanDirs.length - 1
): Promise<void> {
  const call = rec.scanDirs[index]
  if (result instanceof Error) call.reject(result)
  else call.resolve(result)
  await flush()
}
async function answerScan(result: ScanResult | Error, index = rec.scans.length - 1): Promise<void> {
  const call = rec.scans[index]
  if (result instanceof Error) call.reject(result)
  else call.resolve(result)
  await flush()
}
/** 挂上并让头一次扫描落定 */
async function open(
  over: Partial<MobileFilesPageProps> = {},
  result: ScanDirResult = listing()
): Promise<void> {
  mount(over)
  await answerDir(result)
}
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(sel))
const text = (sel: string): string | null => q(sel)?.textContent ?? null
function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const rows = (): Array<{ kind: string | null; path: string | null }> =>
  qa('[data-mobile-file-row]').map((el) => ({
    kind: el.getAttribute('data-mobile-file-row'),
    path: el.getAttribute('data-file-path')
  }))
const row = (path: string): HTMLElement => q(`[data-mobile-file-row][data-file-path="${path}"]`)!
const empty = (): string | null =>
  q('[data-mobile-files-empty]')?.getAttribute('data-mobile-files-empty') ?? null
const count = (): string | null => text('[data-mobile-files-count]')
const searchBox = (): HTMLInputElement =>
  container.querySelector<HTMLInputElement>('[data-mobile-files-search]')!
function type(value: string): void {
  const el = searchBox()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
// 「⋯」
const menuItem = (id: string): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(
    `[data-mobile-pulldown] [data-mobile-menu-item="${id}"]`
  )
const menuIds = (): Array<string | null> =>
  Array.from(document.body.querySelectorAll('[data-mobile-pulldown] [data-mobile-menu-item]')).map(
    (el) => el.getAttribute('data-mobile-menu-item')
  )
const openMenu = (): void => click(q('[data-mobile-files-menu]')!)
function pickMenu(id: string): void {
  openMenu()
  click(menuItem(id)!)
}
// 长按一行
function rowMenu(path: string): { ids: string[]; pick: (id: string) => void } {
  act(() => {
    row(path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  const menu = rec.menus.at(-1)!
  return {
    ids: menu.items.map((item) => item.id ?? `<${item.type}>`),
    pick: (id) => act(() => menu.pick(id))
  }
}
function emitChanged(eventRoot: string): void {
  act(() => rec.handlers['files.changed']?.({ type: 'files.changed', root: eventRoot }))
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  window.history.replaceState(null, '')
  window.localStorage.clear()
  rec.scanDirs.length = 0
  rec.scans.length = 0
  rec.handlers = {}
  rec.menus.length = 0
  rec.copied.length = 0
  onBack.mockReset()
  onOpenDir.mockReset()
  onMentionInserted.mockReset()
  requestFilePreview.mockReset()
  requestMentionInsert.mockReset()
  rec.store.setState({
    projectPath: ROOT,
    composerSessionId: 's1',
    requestFilePreview,
    requestMentionInsert
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = false
})

afterEach(() => {
  unmount()
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MobileFilesPage: loading and the frame', () => {
  it('MF-1 the top level: one scan with stat, the working directory as the title', async () => {
    mount()
    expect(rec.scanDirs).toHaveLength(1)
    expect(rec.scanDirs[0].params).toEqual({ sessionId: 's1', dir: '', stat: true })
    await answerDir(listing())
    expect(rec.scanDirs).toHaveLength(1)
    expect(q('[data-mobile-panel="files"]')).not.toBeNull()
    expect(text('[data-mobile-panel-title]')).toBe('proj')
    expect(q('[data-mobile-panel-subtitle]')).toBeNull()
    expect(text('[data-mobile-panel-back]')).toBe('Chat')
    click(q('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('MF-2 a deeper level: scanned by its path, titled by its name, the path as the subtitle', async () => {
    await open(
      { dir: 'src/main', backLabel: 'src' },
      listing({ dirs: [], files: ['src/main/x.ts'], stats: {} })
    )
    expect(rec.scanDirs[0].params).toEqual({ sessionId: 's1', dir: 'src/main', stat: true })
    expect(text('[data-mobile-panel-title]')).toBe('main')
    expect(text('[data-mobile-panel-subtitle]')).toBe('src/main')
    expect(text('[data-mobile-panel-back]')).toBe('src')
  })

  it('MF-3 folders first, then files, in the order given, in one card', async () => {
    window.localStorage.setItem(HIDDEN_KEY, 'true')
    await open()
    expect(rows()).toEqual([
      { kind: 'dir', path: '.git2' },
      { kind: 'dir', path: 'src' },
      { kind: 'file', path: '.env' },
      { kind: 'file', path: 'a.txt' },
      { kind: 'file', path: 'b.bin' }
    ])
    const cards = qa('[data-mobile-files-list]')
    expect(cards).toHaveLength(1)
    expect(cards[0].querySelectorAll('[data-mobile-file-row]')).toHaveLength(5)
    expect(row('src').textContent).toBe('src')
  })

  it('MF-4 a file with a stat has "size · time" under its name; one without has no second line', async () => {
    await open()
    expect(row('a.txt').querySelector('[data-file-meta]')!.textContent).toBe('1.5 KB · T1000')
    expect(row('b.bin').querySelector('[data-file-meta]')).toBeNull()
    expect(row('b.bin').textContent).toBe('b.bin')
  })

  it('MF-5 a tap on a folder opens it and previews nothing', async () => {
    await open()
    click(row('src'))
    expect(onOpenDir).toHaveBeenCalledTimes(1)
    expect(onOpenDir).toHaveBeenCalledWith('src')
    expect(requestFilePreview).not.toHaveBeenCalled()
  })

  it('MF-5 in a nested page the folder is given by its full relative path', async () => {
    await open({ dir: 'src' }, listing({ dirs: ['src/main/'], files: [], stats: {} }))
    click(row('src/main'))
    expect(onOpenDir).toHaveBeenCalledWith('src/main')
  })

  it('MF-6 a tap on a file asks for its preview by absolute path', async () => {
    await open()
    click(row('a.txt'))
    expect(requestFilePreview).toHaveBeenCalledTimes(1)
    expect(requestFilePreview).toHaveBeenCalledWith('/work/proj/a.txt')
    expect(onOpenDir).not.toHaveBeenCalled()
  })

  it('MF-6 nested: the absolute path keeps the folders', async () => {
    await open({ dir: 'src' }, listing({ dirs: [], files: ['src/x.ts'], stats: {} }))
    click(row('src/x.ts'))
    expect(requestFilePreview).toHaveBeenCalledWith('/work/proj/src/x.ts')
  })
})

describe('MobileFilesPage: hidden entries', () => {
  it('MF-7 by default names starting with a dot are not listed and not counted', async () => {
    await open()
    expect(rows()).toEqual([
      { kind: 'dir', path: 'src' },
      { kind: 'file', path: 'a.txt' },
      { kind: 'file', path: 'b.bin' }
    ])
    expect(count()).toBe('1 folder · 2 files')
  })

  it('MF-8 the menu toggles them, says which way, and remembers it on this device', async () => {
    await open()
    openMenu()
    expect(menuIds()).toEqual(['refresh', 'hidden'])
    expect(menuItem('refresh')!.textContent).toBe(P.filesRefresh)
    expect(menuItem('hidden')!.textContent).toBe(M.filesShowHidden)
    click(menuItem('hidden')!)
    expect(menuItem('hidden')).toBeNull()
    expect(rows().map((r) => r.path)).toEqual(['.git2', 'src', '.env', 'a.txt', 'b.bin'])
    expect(count()).toBe('2 folders · 3 files')
    expect(window.localStorage.getItem(HIDDEN_KEY)).toBe('true')

    openMenu()
    expect(menuItem('hidden')!.textContent).toBe(M.filesHideHidden)
    click(menuItem('hidden')!)
    expect(rows().map((r) => r.path)).toEqual(['src', 'a.txt', 'b.bin'])
    expect(window.localStorage.getItem(HIDDEN_KEY)).toBe('false')
    // 切换不重扫
    expect(rec.scanDirs).toHaveLength(1)
  })

  it('MF-9 a remembered "show" lists them from the first render', async () => {
    window.localStorage.setItem(HIDDEN_KEY, 'true')
    await open()
    expect(rows()).toHaveLength(5)
    expect(count()).toBe('2 folders · 3 files')
  })

  it('MF-10 a folder holding only hidden entries reads as empty until they are shown', async () => {
    await open({}, listing({ dirs: ['.cache/'], files: ['.env'], stats: {} }))
    expect(empty()).toBe('folder')
    expect(rows()).toEqual([])
    pickMenu('hidden')
    expect(empty()).toBeNull()
    expect(rows().map((r) => r.path)).toEqual(['.cache', '.env'])
  })
})

describe('MobileFilesPage: empty, failed, refresh', () => {
  it('MF-11 an empty folder says so', async () => {
    await open({}, listing({ dirs: [], files: [], stats: {} }))
    expect(empty()).toBe('folder')
    expect(text('[data-mobile-files-empty]')).toBe(M.filesEmpty)
    expect(count()).toBe('0 files')
  })

  it('MF-12 a first scan that rejects shows the error', async () => {
    mount()
    expect(empty()).toBeNull()
    await answerDir(new Error('offline'))
    expect(empty()).toBe('error')
    expect(text('[data-mobile-files-empty]')).toBe(P.filesError)
    expect(count()).toBe('')
  })

  it('MF-12 a first scan with no working directory shows the error', async () => {
    mount()
    await answerDir({ root: null, dirs: [], files: [] })
    expect(empty()).toBe('error')
    // 没有根就没有名字：标题退回「文件」
    rec.store.setState({ projectPath: null })
    await flush()
    expect(text('[data-mobile-panel-title]')).toBe(M.files)
  })

  it.each<[string, ScanDirResult | Error]>([
    ['rejects', new Error('offline')],
    ['finds no working directory', { root: null, dirs: [], files: [] }]
  ])('MF-13 a refresh that %s keeps the rows that were there', async (_label, result) => {
    await open()
    pickMenu('refresh')
    expect(rec.scanDirs).toHaveLength(2)
    expect(rec.scanDirs[1].params).toEqual({ sessionId: 's1', dir: '', stat: true })
    await answerDir(result)
    expect(empty()).toBeNull()
    expect(rows().map((r) => r.path)).toEqual(['src', 'a.txt', 'b.bin'])
  })

  it('MF-13 a refresh that succeeds replaces the rows', async () => {
    await open()
    pickMenu('refresh')
    await answerDir(listing({ dirs: [], files: ['new.txt'], stats: {} }))
    expect(rows().map((r) => r.path)).toEqual(['new.txt'])
  })

  it('MF-14 only the newest scan is applied: an older one that resolves last is ignored', async () => {
    mount()
    pickMenu('refresh')
    expect(rec.scanDirs).toHaveLength(2)
    await answerDir(listing({ dirs: [], files: ['newest.txt'], stats: {} }), 1)
    expect(rows().map((r) => r.path)).toEqual(['newest.txt'])
    await answerDir(listing({ dirs: [], files: ['older.txt'], stats: {} }), 0)
    expect(rows().map((r) => r.path)).toEqual(['newest.txt'])
  })

  it('MF-14 an older scan that rejects late does not turn a good listing into an error', async () => {
    mount()
    pickMenu('refresh')
    await answerDir(listing(), 1)
    await answerDir(new Error('late'), 0)
    expect(empty()).toBeNull()
    expect(rows()).toHaveLength(3)
  })

  it('MF-14 a result that arrives after unmount writes nothing', async () => {
    mount()
    unmount()
    await expect(answerDir(listing(), 0)).resolves.toBeUndefined()
  })
})

describe('MobileFilesPage: files.changed', () => {
  it('MF-15 events for this root within 300 ms rescan once', async () => {
    await open()
    emitChanged(ROOT)
    advance(100)
    emitChanged(ROOT)
    advance(100)
    emitChanged(ROOT)
    advance(299)
    expect(rec.scanDirs).toHaveLength(1)
    advance(1)
    expect(rec.scanDirs).toHaveLength(2)
    expect(rec.scanDirs[1].params).toEqual({ sessionId: 's1', dir: '', stat: true })
    advance(1000)
    expect(rec.scanDirs).toHaveLength(2)
    await answerDir(listing({ dirs: [], files: ['changed.txt'], stats: {} }))
    expect(rows().map((r) => r.path)).toEqual(['changed.txt'])
  })

  it('MF-16 an event for another root does not rescan', async () => {
    await open()
    emitChanged('/work/other')
    advance(1000)
    expect(rec.scanDirs).toHaveLength(1)
  })

  it("MF-16 the root that counts is the listing's own, not the store's spelling of it", async () => {
    rec.store.setState({ projectPath: '/tmp/link' })
    await open({}, listing({ root: '/private/tmp/real' }))
    emitChanged('/tmp/link')
    advance(1000)
    expect(rec.scanDirs).toHaveLength(1)
    emitChanged('/private/tmp/real')
    advance(300)
    expect(rec.scanDirs).toHaveLength(2)
  })

  it("MF-16 before the first listing arrives the session's working directory counts", () => {
    mount()
    emitChanged('/work/other')
    advance(300)
    expect(rec.scanDirs).toHaveLength(1)
    emitChanged(ROOT)
    advance(300)
    expect(rec.scanDirs).toHaveLength(2)
  })

  it('MF-16 with neither a listing nor a working directory nothing rescans', () => {
    rec.store.setState({ projectPath: null })
    mount()
    emitChanged(ROOT)
    advance(1000)
    expect(rec.scanDirs).toHaveLength(1)
  })

  it('MF-16 a pending rescan is dropped at unmount', async () => {
    await open()
    emitChanged(ROOT)
    unmount()
    advance(1000)
    expect(rec.scanDirs).toHaveLength(1)
  })
})

describe('MobileFilesPage: search', () => {
  const all = (paths: string[], truncated = false): ScanResult => ({
    paths,
    truncated,
    root: ROOT
  })

  it('MF-17 the full scan happens once, 250 ms after the first typing', async () => {
    await open()
    type('a')
    advance(249)
    expect(rec.scans).toHaveLength(0)
    advance(1)
    expect(rec.scans).toHaveLength(1)
    expect(rec.scans[0].params).toEqual({ sessionId: 's1' })
    type('ab')
    advance(500)
    expect(rec.scans).toHaveLength(1)
    await answerScan(all(['abc.txt', 'x/abd.txt']))
    type('abc')
    advance(500)
    expect(rec.scans).toHaveLength(1)
    expect(rows().map((r) => r.path)).toEqual(['abc.txt'])
  })

  it('MF-17 typing that is cleared before 250 ms scans nothing', async () => {
    await open()
    type('a')
    advance(100)
    type('')
    advance(1000)
    expect(rec.scans).toHaveLength(0)
    expect(rows().map((r) => r.path)).toEqual(['src', 'a.txt', 'b.bin'])
  })

  it('MF-18 results are file rows in search order; the second line is the folder', async () => {
    await open()
    type('x')
    advance(250)
    await answerScan(all(['src/main/x.ts', 'x.md', 'xdir/a.ts', 'src/a.ts']))
    const card = q('[data-mobile-files-results]')!
    const found = Array.from(card.querySelectorAll<HTMLElement>('[data-mobile-file-row]'))
    expect(found.map((el) => el.getAttribute('data-mobile-file-row'))).toEqual([
      'file',
      'file',
      'file'
    ])
    expect(found.map((el) => el.getAttribute('data-file-path'))).toEqual([
      'src/main/x.ts',
      'x.md',
      'xdir/a.ts'
    ])
    expect(row('src/main/x.ts').querySelector('[data-file-meta]')!.textContent).toBe('src/main')
    expect(row('x.md').querySelector('[data-file-meta]')).toBeNull()
    click(row('src/main/x.ts'))
    expect(requestFilePreview).toHaveBeenCalledWith('/work/proj/src/main/x.ts')
  })

  it('MF-18 a nested page searches below its own folder only', async () => {
    await open({ dir: 'src' }, listing({ dirs: [], files: ['src/a.ts'], stats: {} }))
    type('a')
    advance(250)
    await answerScan(all(['a.txt', 'src/a.ts', 'src/deep/a.md', 'src2/a.ts']))
    expect(rows().map((r) => r.path)).toEqual(['src/a.ts', 'src/deep/a.md'])
  })

  it('MF-19 no match says so, and the folder listing is not shown while searching', async () => {
    await open()
    type('zzz')
    expect(q('[data-mobile-files-list]')).toBeNull()
    expect(empty()).toBeNull()
    advance(250)
    await answerScan(all(['a.txt']))
    expect(empty()).toBe('search')
    expect(text('[data-mobile-files-empty]')).toBe(M.filesSearchEmpty)
    expect(q('[data-mobile-files-list]')).toBeNull()
    expect(count()).toBe('0 files')
  })

  it('MF-19 clearing the box brings the folder listing back', async () => {
    await open()
    type('zzz')
    advance(250)
    await answerScan(all(['a.txt']))
    click(q('[data-mobile-files-search-clear]')!)
    expect(searchBox().value).toBe('')
    expect(q('[data-mobile-files-search-clear]')).toBeNull()
    expect(rows().map((r) => r.path)).toEqual(['src', 'a.txt', 'b.bin'])
  })

  it('MF-19 a full scan that rejects is an error, not "no files found"', async () => {
    await open()
    type('a')
    advance(250)
    await answerScan(new Error('offline'))
    expect(empty()).toBe('error')
    expect(text('[data-mobile-files-empty]')).toBe(P.filesError)
    expect(count()).toBe('')
    // 不自己重试
    type('ab')
    advance(1000)
    expect(rec.scans).toHaveLength(1)
  })

  it('MF-20 refresh with a query in the box rescans the folder and, 250 ms later, the full list', async () => {
    await open()
    type('a')
    advance(250)
    await answerScan(all(['a.txt']))
    pickMenu('refresh')
    expect(rec.scanDirs).toHaveLength(2)
    expect(rec.scans).toHaveLength(1)
    advance(249)
    expect(rec.scans).toHaveLength(1)
    advance(1)
    expect(rec.scans).toHaveLength(2)
    await answerScan(all(['a.txt', 'a2.txt']))
    expect(rows().map((r) => r.path)).toEqual(['a.txt', 'a2.txt'])
  })

  it('MF-20 refresh with an empty box drops the cached list: the next typing scans again', async () => {
    await open()
    type('a')
    advance(250)
    await answerScan(all(['a.txt']))
    type('')
    pickMenu('refresh')
    advance(1000)
    expect(rec.scans).toHaveLength(1)
    type('a')
    advance(250)
    expect(rec.scans).toHaveLength(2)
  })

  it('MF-20 refresh after a failed full scan tries it again', async () => {
    await open()
    type('a')
    advance(250)
    await answerScan(new Error('offline'))
    pickMenu('refresh')
    advance(250)
    expect(rec.scans).toHaveLength(2)
    await answerScan(all(['a.txt']))
    expect(empty()).toBeNull()
    expect(rows().map((r) => r.path)).toEqual(['a.txt'])
  })

  it('MF-20 a files.changed event drops the cached list too', async () => {
    await open()
    type('a')
    advance(250)
    await answerScan(all(['a.txt']))
    emitChanged(ROOT)
    advance(300)
    expect(rec.scanDirs).toHaveLength(2)
    expect(rec.scans).toHaveLength(1)
    advance(250)
    expect(rec.scans).toHaveLength(2)
    await answerScan(all(['a.txt', 'a-new.txt']))
    expect(rows().map((r) => r.path)).toEqual(['a.txt', 'a-new.txt'])
  })

  it('MF-21 the toolbar counts the results while searching', async () => {
    await open()
    type('a')
    expect(count()).toBe('')
    advance(250)
    await answerScan(all(['a.txt', 'b/a.md', 'c.txt']))
    expect(count()).toBe('2 files')
    type('a.t')
    expect(count()).toBe('1 file')
  })

  it.each([
    ['with results', 'a'],
    ['with no result', 'zzz']
  ])('MF-21 a truncated full list says so instead (%s)', async (_label, query) => {
    await open()
    type(query)
    advance(250)
    await answerScan(all(['a.txt', 'b/a.md', 'c.txt'], true))
    expect(count()).toBe(i18n.t('panel.filesTruncated', { count: 3 }))
  })
})

describe('MobileFilesPage: the toolbar', () => {
  it.each<[string, Partial<ScanDirResult>, string]>([
    ['folders and files', {}, '2 folders · 3 files'],
    ['no folders', { dirs: [] }, '3 files'],
    ['singular forms', { dirs: ['src/'], files: ['a.txt'] }, '1 folder · 1 file'],
    ['folders only', { files: [] }, '2 folders · 0 files']
  ])('MF-22 %s', async (_label, over, expected) => {
    window.localStorage.setItem(HIDDEN_KEY, 'true')
    await open({}, listing(over))
    expect(count()).toBe(expected)
  })

  it('MF-22 nothing before the first listing', () => {
    mount()
    expect(count()).toBe('')
  })
})

describe('MobileFilesPage: the row menu', () => {
  const nested = (): Promise<void> =>
    open({ dir: 'src' }, listing({ dirs: ['src/main/'], files: ['src/x.ts'], stats: {} }))

  it('MF-23 a file row: open, mention, then the two copies', async () => {
    await nested()
    const menu = rowMenu('src/x.ts')
    expect(menu.ids).toEqual(['open', 'mention', '<separator>', 'copyPath', 'copyRelativePath'])
    expect(rec.menus.at(-1)!.items.map((item) => item.label)).toEqual([
      P.filesMenu.open,
      P.filesMenu.mention,
      undefined,
      P.filesMenu.copyPath,
      P.filesMenu.copyRelativePath
    ])
  })

  it.each([
    ['another session', 's2'],
    ['no composer', null]
  ])('MF-23 with %s holding the composer there is no mention item', async (_label, composer) => {
    rec.store.setState({ composerSessionId: composer })
    await nested()
    expect(rowMenu('src/x.ts').ids).toEqual(['open', '<separator>', 'copyPath', 'copyRelativePath'])
  })

  it('MF-24 a folder row: the two copies only', async () => {
    await nested()
    expect(rowMenu('src/main').ids).toEqual(['copyPath', 'copyRelativePath'])
  })

  it('MF-23 open previews the file', async () => {
    await nested()
    rowMenu('src/x.ts').pick('open')
    expect(requestFilePreview).toHaveBeenCalledWith('/work/proj/src/x.ts')
  })

  it('MF-25 mention inserts a file chip for this session, then tells the page stack', async () => {
    await nested()
    rowMenu('src/x.ts').pick('mention')
    expect(requestMentionInsert).toHaveBeenCalledTimes(1)
    expect(requestMentionInsert).toHaveBeenCalledWith(
      's1',
      { kind: 'file', rel: 'src/x.ts', base: 'x.ts' },
      'x.ts'
    )
    expect(onMentionInserted).toHaveBeenCalledTimes(1)
    expect(requestMentionInsert.mock.invocationCallOrder[0]).toBeLessThan(
      onMentionInserted.mock.invocationCallOrder[0]
    )
  })

  it('MF-26 copy path / copy relative path, for a file and for a folder', async () => {
    await nested()
    rowMenu('src/x.ts').pick('copyPath')
    rowMenu('src/x.ts').pick('copyRelativePath')
    rowMenu('src/main').pick('copyPath')
    rowMenu('src/main').pick('copyRelativePath')
    expect(rec.copied).toEqual([
      '/work/proj/src/x.ts',
      'src/x.ts',
      '/work/proj/src/main',
      'src/main'
    ])
    expect(onMentionInserted).not.toHaveBeenCalled()
  })

  it('MF-27 a Windows working directory: paths use its separator', async () => {
    await open(
      { dir: 'src' },
      listing({ root: 'C:\\w\\p', dirs: [], files: ['src/x.ts'], stats: {} })
    )
    expect(text('[data-mobile-panel-title]')).toBe('src')
    rowMenu('src/x.ts').pick('copyPath')
    rowMenu('src/x.ts').pick('copyRelativePath')
    expect(rec.copied).toEqual(['C:\\w\\p\\src\\x.ts', 'src\\x.ts'])
    click(row('src/x.ts'))
    expect(requestFilePreview).toHaveBeenCalledWith('C:\\w\\p\\src\\x.ts')
  })

  it('MF-23 a result row in a search has the file menu too', async () => {
    await open()
    type('x')
    advance(250)
    rec.scans[0].resolve({ paths: ['src/x.ts'], truncated: false, root: ROOT })
    await flush()
    const menu = rowMenu('src/x.ts')
    expect(menu.ids).toEqual(['open', 'mention', '<separator>', 'copyPath', 'copyRelativePath'])
    menu.pick('copyRelativePath')
    expect(rec.copied).toEqual(['src/x.ts'])
  })
})
