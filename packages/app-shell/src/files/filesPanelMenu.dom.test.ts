// @vitest-environment jsdom
/**
 * Files 面板的条目右键（手机长按）菜单与两档密度（FilesPanel，jsdom）。
 *
 * 契约（FilesPanel.tsx 头注释 + props）：文件 = 打开 / 在对话中引用；文件与目录 = 复制路径 / 复制相对路径 /
 * 在文件夹中显示（宿主注入 onRevealPath 才有）。只读，不改磁盘。经共享的 useContextMenu 弹。「在对话中引用」
 * 只在这个会话挂着输入框时给（chatStore.composerSessionId），选了它 → 往该会话的输入框插胶囊（与 @ 弹层选中
 * 同一结果）并告诉树「焦点已交出去」。复制出的路径用工作目录自己的分隔符（Windows 工作目录 → `\`）。
 * 密度跟 ChatHost 走：touch → 树 touch 档、顶栏 h-11、36px 按钮 18px 图标、搜索框 16px 字。
 *
 * 文件树桩掉（只记 props 与挂载次数），菜单渲染器是 ContextMenuProvider 的 render：记下菜单项与弹出点，回给定的 id
 * （null = 取消）。会话渠道 API 是假的：除 files.scanDir / files.scan / events.subscribe 之外的任何调用都记下来
 * （FM-11 据此断言「只读」）。文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），一律 createElement。
 *
 *   FM-1  文件 + onRevealPath：恰为 [打开, 引用, 分隔, 复制路径, 复制相对路径, 分隔, 在文件夹中显示]，弹出点原样，
 *         没有 role
 *   FM-2  目录：[复制路径, 复制相对路径, 分隔, 在文件夹中显示]
 *   FM-3  不注入 onRevealPath：文件 [打开, 引用, 分隔, 复制路径, 复制相对路径]（不留尾分隔）；目录只有两项复制
 *   FM-13 composerSessionId 为空或是别的会话：文件菜单没有「引用」
 *   FM-4  「打开」文本文件 = 点击：filePreviewRequest.absPath 相同
 *   FM-5  「打开」音视频 = 点击：音频 / 视频 dock，不发预览请求
 *   FM-6  「引用」docs/a b.md → mentionInsertRequest（会话、引用、胶囊明文）；onMentionInserted 一次；回 'focus-moved'
 *   FM-7  其余每一项与取消都回 undefined、不调 onMentionInserted；取消什么动作都不做
 *   FM-8  POSIX 复制：文件 / 目录 / 尾斜杠的工作目录 / 含 `\` 的 POSIX 工作目录
 *   FM-9  Windows / UNC 工作目录：相对路径与绝对路径都用 `\`，reveal 拿到同一个绝对路径
 *   FM-10 reveal → onRevealPath 恰一次，绝对路径（目录不带尾斜杠）
 *   FM-11 只读：做完每个动作，假 API 只见过 scanDir（搜索时还有 scan）
 *   FM-12 [白盒] 没有会话 / 没有工作目录：树不挂，交不出右键回调，渲染器从不被调
 *   FD-1  compact（没有 ChatHost / density compact）：树 'compact'；按钮 p-1、11px 图标；搜索框 text-[11px]
 *   FD-2  touch：树 'touch'；顶栏 h-11；按钮 p-[9px]、18px 图标；搜索框 text-[16px]、16px 前置图标
 *   FD-3  [白盒] 挂着的面板换档 → 树重挂一次，新档位
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import {
  ChatHostProvider,
  setSessionChannelApi,
  useChatStore,
  type ChatHostValue
} from '@shuvix/chat-ui'
import type { FilesTreeContextMenuItem, FilesTreeDensity } from './FilesTree'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface StubProps {
  density?: FilesTreeDensity
  onItemContextMenu?: (
    item: FilesTreeContextMenuItem,
    position: { x: number; y: number }
  ) => Promise<void | 'focus-moved'> | void
  onFileSelect: (rel: string) => void
}

const rec = vi.hoisted(() => ({
  /** 桩树每次渲染收到的 props */
  renders: [] as unknown[],
  /** 每次挂载时的档位 */
  mounts: [] as Array<string | undefined>
}))

vi.mock('./FilesTree', async () => {
  const React = await import('react')
  return {
    FilesTree: (props: { density?: string }) => {
      rec.renders.push(props)
      React.useEffect(() => {
        rec.mounts.push(props.density)
        // 挂载期那一次的档位：之后的渲染不该再记
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return React.createElement('div', { 'data-tree-stub': props.density ?? '' })
    }
  }
})

import { FilesPanel, type FilesPanelProps } from './FilesPanel'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

const ROOT = '/w/proj'
const SID = 'S1'

// ── 假后端 ────────────────────────────────────────────────────────────────

/** 除允许的几个之外的调用（FM-11） */
let otherCalls: string[]
let scanDirCalls: number
let scanCalls: number
let listeners: Set<(e: AppEvent) => void>

function fakeApi(): SessionChannelApi {
  const impl: Record<string, Record<string, (...args: unknown[]) => unknown>> = {
    files: {
      scanDir: async () => {
        scanDirCalls++
        return {
          root: useChatStore.getState().projectPath,
          dirs: ['docs/'],
          files: ['a.txt', 'docs/a b.md', 'song.mp3', 'clip.mp4']
        }
      },
      scan: async () => {
        scanCalls++
        return { root: useChatStore.getState().projectPath, paths: [], truncated: false }
      }
    },
    events: {
      subscribe: (cb: unknown) => {
        listeners.add(cb as (e: AppEvent) => void)
        return () => listeners.delete(cb as (e: AppEvent) => void)
      }
    }
  }
  return new Proxy(
    {},
    {
      get: (_, ns) => {
        if (typeof ns !== 'string') return undefined
        return new Proxy(
          {},
          {
            get: (__, method) => {
              if (typeof method !== 'string') return undefined
              const fn = impl[ns]?.[method]
              if (fn) return fn
              return (...args: unknown[]) => {
                otherCalls.push(`${ns}.${method}`)
                void args
                return Promise.resolve(undefined)
              }
            }
          }
        )
      }
    }
  ) as SessionChannelApi
}

// ── 菜单渲染器 / 剪贴板 ───────────────────────────────────────────────────

/** 渲染器收到的每一次 (items, position) */
let menus: Array<{ items: ContextMenuItem[]; position: { x: number; y: number } }>
/** 下一次菜单回哪个 id（null = 取消） */
let pick: string | null
const renderer = (
  items: ContextMenuItem[],
  position: { x: number; y: number }
): Promise<string | null> => {
  menus.push({ items, position })
  return Promise.resolve(pick)
}

let copied: string[]

// ── 渲染 ──────────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

const HOST_BASE: ChatHostValue = {
  appearance: { theme: 'light', darkTheme: 'd', lightTheme: 'l', fontSize: 14, focusMode: false },
  models: {
    activeProvider: '',
    activeModel: '',
    setActiveProvider: () => {},
    setActiveModel: () => {}
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 挂面板；density 给了就包一层 ChatHostProvider */
async function render(
  props: FilesPanelProps = {},
  opts: { density?: 'compact' | 'touch' } = {}
): Promise<void> {
  const panel = createElement(FilesPanel as (p: FilesPanelProps) => React.JSX.Element, {
    ...props
  })
  const Host = ChatHostProvider as unknown as (p: {
    value: ChatHostValue
    children?: ReactNode
  }) => React.JSX.Element
  const Menu = ContextMenuProvider as unknown as (p: {
    render: typeof renderer
    children?: ReactNode
  }) => React.JSX.Element
  const hosted: ReactNode = opts.density
    ? createElement(Host, { value: { ...HOST_BASE, density: opts.density } }, panel)
    : panel
  act(() => {
    root.render(createElement(Menu, { render: renderer }, hosted))
  })
  await flush()
}

const lastTree = (): StubProps => {
  const p = rec.renders.at(-1) as StubProps | undefined
  if (!p) throw new Error('the tree was never rendered')
  return p
}

/** 右键一个条目，选 `choice`（null = 取消）；回 handler 的结果 */
async function contextMenu(
  item: FilesTreeContextMenuItem,
  choice: string | null
): Promise<void | 'focus-moved'> {
  const handler = lastTree().onItemContextMenu
  if (!handler) throw new Error('no onItemContextMenu handed to the tree')
  pick = choice
  let res: void | 'focus-moved' = undefined
  await act(async () => {
    res = await handler(item, { x: 5, y: 6 })
  })
  await flush()
  return res
}

const FILE = (path: string): FilesTreeContextMenuItem => ({ path, kind: 'file' })
const DIR = (path: string): FilesTreeContextMenuItem => ({ path, kind: 'directory' })

const lastMenu = (): (typeof menus)[number] => {
  const m = menus.at(-1)
  if (!m) throw new Error('no menu was shown')
  return m
}

const SEP = { type: 'separator' } as const
const OPEN = { id: 'open', label: 'Open' }
const MENTION = { id: 'mention', label: 'Mention in chat' }
const COPY = { id: 'copyPath', label: 'Copy path' }
const COPY_REL = { id: 'copyRelativePath', label: 'Copy relative path' }
const REVEAL = { id: 'reveal', label: 'Show in folder' }

/** 换工作目录（假 scanDir 按 store 里的 projectPath 回 root），等新树挂上 */
async function switchRoot(next: string): Promise<void> {
  act(() => useChatStore.setState({ projectPath: next }))
  await flush()
}

beforeAll(async () => {
  // jsdom 没有 ResizeObserver（VideoDock 量容器宽度用它）
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  rec.renders.length = 0
  rec.mounts.length = 0
  otherCalls = []
  scanDirCalls = 0
  scanCalls = 0
  listeners = new Set()
  menus = []
  pick = null
  copied = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text)
        return Promise.resolve()
      }
    }
  })
  setSessionChannelApi(fakeApi())
  useChatStore.setState({
    activeSessionId: SID,
    projectPath: ROOT,
    composerSessionId: SID,
    filePreviewRequest: null,
    mentionInsertRequest: null
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Files panel item menu — items', () => {
  it('FM-1 a file with onRevealPath gets exactly open, mention, copy ×2, reveal; position as given; no roles', async () => {
    await render({ onRevealPath: vi.fn() })
    await contextMenu(FILE('a.txt'), null)
    expect(menus).toHaveLength(1)
    expect(lastMenu().items).toEqual([OPEN, MENTION, SEP, COPY, COPY_REL, SEP, REVEAL])
    expect(lastMenu().position).toEqual({ x: 5, y: 6 })
    expect(lastMenu().items.some((i) => 'role' in i)).toBe(false)
  })

  it('FM-2 a folder gets copy ×2 and reveal', async () => {
    await render({ onRevealPath: vi.fn() })
    await contextMenu(DIR('docs'), null)
    expect(lastMenu().items).toEqual([COPY, COPY_REL, SEP, REVEAL])
  })

  it('FM-3 without onRevealPath there is no reveal and no trailing separator', async () => {
    await render()
    await contextMenu(FILE('a.txt'), null)
    expect(lastMenu().items).toEqual([OPEN, MENTION, SEP, COPY, COPY_REL])
    await contextMenu(DIR('docs'), null)
    expect(lastMenu().items).toEqual([COPY, COPY_REL])
  })

  it.each([
    ['no composer at all', null],
    ['a composer for another session', 'S2']
  ])('FM-13 %s → the file menu has no mention item', async (_, composer) => {
    act(() => useChatStore.setState({ composerSessionId: composer }))
    await render({ onRevealPath: vi.fn() })
    await contextMenu(FILE('a.txt'), null)
    expect(lastMenu().items).toEqual([OPEN, SEP, COPY, COPY_REL, SEP, REVEAL])
  })
})

describe('Files panel item menu — actions', () => {
  it('FM-4 Open on a text file requests the same preview as a click', async () => {
    await render()
    await contextMenu(FILE('a.txt'), 'open')
    const viaMenu = useChatStore.getState().filePreviewRequest
    expect(viaMenu?.absPath).toBe('/w/proj/a.txt')

    act(() => useChatStore.setState({ filePreviewRequest: null }))
    act(() => lastTree().onFileSelect('a.txt'))
    const viaClick = useChatStore.getState().filePreviewRequest
    expect(viaClick?.absPath).toBe(viaMenu?.absPath)
    expect(viaClick?.openedBy).toBe(viaMenu?.openedBy)
  })

  it.each([
    ['song.mp3', 'audio'],
    ['clip.mp4', 'video']
  ])(
    'FM-5 Open on %s shows the %s dock like a click, and requests no preview',
    async (file, kind) => {
      const dockOf = (): { audio: boolean; video: boolean; title: string | null } => ({
        audio: container.querySelector('audio') !== null,
        video: container.querySelector('video') !== null,
        title: container.querySelector(`[title="${file}"]`)?.getAttribute('title') ?? null
      })

      await render()
      expect(dockOf()).toEqual({ audio: false, video: false, title: null })
      await contextMenu(FILE(file), 'open')
      const viaMenu = dockOf()
      expect(viaMenu).toEqual({ audio: kind === 'audio', video: kind === 'video', title: file })
      expect(useChatStore.getState().filePreviewRequest).toBeNull()

      // 同一个文件点一下：同样的 dock
      act(() => root.unmount())
      root = createRoot(container)
      await render()
      expect(dockOf().title).toBeNull()
      act(() => lastTree().onFileSelect(file))
      await flush()
      expect(dockOf()).toEqual(viaMenu)
      expect(useChatStore.getState().filePreviewRequest).toBeNull()
    }
  )

  it('FM-6 Mention inserts a file reference into this session’s composer and reports focus-moved', async () => {
    const onMentionInserted = vi.fn()
    await render({ onMentionInserted })
    const res = await contextMenu(FILE('docs/a b.md'), 'mention')
    expect(res).toBe('focus-moved')
    expect(onMentionInserted).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().mentionInsertRequest).toEqual({
      sessionId: SID,
      ref: { kind: 'file', rel: 'docs/a b.md', base: 'a b.md' },
      displayText: 'a b.md',
      nonce: expect.any(Number)
    })
  })

  it('FM-7 every other pick and a cancel resolve undefined and never call onMentionInserted; cancel does nothing', async () => {
    const onMentionInserted = vi.fn()
    const onRevealPath = vi.fn()
    await render({ onMentionInserted, onRevealPath })
    for (const choice of ['open', 'copyPath', 'copyRelativePath', 'reveal']) {
      expect(await contextMenu(FILE('a.txt'), choice), choice).toBeUndefined()
    }
    expect(await contextMenu(DIR('docs'), 'copyPath')).toBeUndefined()
    expect(onMentionInserted).not.toHaveBeenCalled()

    // 取消：什么都不做
    copied = []
    onRevealPath.mockClear()
    act(() => useChatStore.setState({ filePreviewRequest: null, mentionInsertRequest: null }))
    expect(await contextMenu(FILE('a.txt'), null)).toBeUndefined()
    expect(await contextMenu(DIR('docs'), null)).toBeUndefined()
    expect(copied).toEqual([])
    expect(onRevealPath).not.toHaveBeenCalled()
    expect(onMentionInserted).not.toHaveBeenCalled()
    expect(useChatStore.getState().filePreviewRequest).toBeNull()
    expect(useChatStore.getState().mentionInsertRequest).toBeNull()
    expect(container.querySelector('audio, video')).toBeNull()
  })

  it('FM-8 POSIX copies: file, folder, a root with a trailing slash, a POSIX root containing a backslash', async () => {
    await render()
    await contextMenu(FILE('docs/a b.md'), 'copyPath')
    await contextMenu(FILE('docs/a b.md'), 'copyRelativePath')
    await contextMenu(DIR('docs'), 'copyPath')
    await contextMenu(DIR('docs'), 'copyRelativePath')
    expect(copied).toEqual(['/w/proj/docs/a b.md', 'docs/a b.md', '/w/proj/docs', 'docs'])

    copied = []
    await switchRoot('/w/proj/')
    await contextMenu(FILE('docs/a b.md'), 'copyPath')
    expect(copied).toEqual(['/w/proj/docs/a b.md'])

    copied = []
    await switchRoot('/w/we\\ird')
    await contextMenu(FILE('docs/a b.md'), 'copyRelativePath')
    await contextMenu(FILE('docs/a b.md'), 'copyPath')
    expect(copied).toEqual(['docs/a b.md', '/w/we\\ird/docs/a b.md'])
  })

  it.each([
    ['a Windows drive root', 'C:\\Users\\u\\proj'],
    ['a UNC root', '\\\\srv\\share\\p']
  ])(
    'FM-9 %s: relative and absolute paths use backslashes, reveal gets the same absolute path',
    async (_, winRoot) => {
      const onRevealPath = vi.fn()
      act(() => useChatStore.setState({ projectPath: winRoot }))
      await render({ onRevealPath })
      await contextMenu(FILE('docs/a b.md'), 'copyRelativePath')
      await contextMenu(FILE('docs/a b.md'), 'copyPath')
      await contextMenu(FILE('docs/a b.md'), 'reveal')
      const abs = `${winRoot}\\docs\\a b.md`
      expect(copied).toEqual(['docs\\a b.md', abs])
      expect(onRevealPath).toHaveBeenCalledTimes(1)
      expect(onRevealPath).toHaveBeenCalledWith(abs)
    }
  )

  it('FM-10 reveal calls onRevealPath once with the absolute path, for a file and a folder', async () => {
    const onRevealPath = vi.fn()
    await render({ onRevealPath })
    await contextMenu(FILE('docs/a b.md'), 'reveal')
    expect(onRevealPath.mock.calls).toEqual([['/w/proj/docs/a b.md']])
    await contextMenu(DIR('docs'), 'reveal')
    expect(onRevealPath.mock.calls).toEqual([['/w/proj/docs/a b.md'], ['/w/proj/docs']])
  })

  it('FM-11 read-only: after every action the backend saw only files.scanDir (and scan once search ran)', async () => {
    await render({ onRevealPath: vi.fn(), onMentionInserted: vi.fn() })
    for (const item of [FILE('a.txt'), FILE('docs/a b.md'), FILE('song.mp3')]) {
      for (const choice of ['open', 'mention', 'copyPath', 'copyRelativePath', 'reveal', null]) {
        await contextMenu(item, choice)
      }
    }
    for (const choice of ['copyPath', 'copyRelativePath', 'reveal', null]) {
      await contextMenu(DIR('docs'), choice)
    }
    expect(scanDirCalls).toBeGreaterThan(0)
    expect(scanCalls).toBe(0)
    expect(otherCalls).toEqual([])
  })

  it.each([
    ['no active session', { activeSessionId: null }],
    ['no working directory', { projectPath: null }]
  ])(
    'FM-12 [white-box] %s: the tree is not mounted, so no handler is handed out and the renderer is never called',
    async (_, patch) => {
      await render({ onRevealPath: vi.fn() })
      expect(lastTree().onItemContextMenu).toBeTypeOf('function')
      const before = rec.renders.length
      act(() => useChatStore.setState(patch))
      await flush()
      expect(container.querySelector('[data-tree-stub]')).toBeNull()
      expect(rec.renders.length).toBe(before)
      expect(menus).toEqual([])
    }
  )
})

describe('Files panel density', () => {
  const header = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('.bg-bg-secondary')?.firstElementChild
    if (!el) throw new Error('panel header not rendered')
    return el as HTMLElement
  }
  const button = (title: string): HTMLButtonElement => {
    const el = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
    if (!el) throw new Error(`no button titled ${title}`)
    return el
  }
  const iconSize = (el: Element): string | null =>
    el.querySelector('svg')?.getAttribute('width') ?? null
  const openSearch = async (): Promise<HTMLInputElement> => {
    act(() => button('Search').click())
    await flush()
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Search"]')
    if (!input) throw new Error('search input not shown')
    return input
  }

  it.each([
    ['no ChatHost', undefined],
    ["ChatHost density 'compact'", 'compact' as const]
  ])(
    'FD-1 %s → compact tree, p-1 buttons with 11px icons, an 11px search input',
    async (_, density) => {
      await render({ onOpenFolder: vi.fn() }, { density })
      expect(lastTree().density).toBe('compact')
      expect(rec.mounts).toEqual(['compact'])
      expect(header().classList.contains('h-7')).toBe(true)
      for (const title of ['Search', 'Refresh', ROOT]) {
        const b = button(title)
        expect(b.classList.contains('p-1'), title).toBe(true)
        expect(iconSize(b), title).toBe('11')
      }
      const input = await openSearch()
      expect(input.classList.contains('text-[11px]')).toBe(true)
      expect(iconSize(input.parentElement!)).toBe('11')
    }
  )

  it("FD-2 ChatHost density 'touch' → touch tree, an h-11 header, 36px buttons with 18px icons, a 16px search input", async () => {
    await render({ onOpenFolder: vi.fn() }, { density: 'touch' })
    expect(lastTree().density).toBe('touch')
    expect(rec.mounts).toEqual(['touch'])
    expect(header().classList.contains('h-11')).toBe(true)
    for (const title of ['Search', 'Refresh', ROOT]) {
      const b = button(title)
      expect(b.classList.contains('p-[9px]'), title).toBe(true)
      expect(iconSize(b), title).toBe('18')
    }
    const input = await openSearch()
    expect(input.classList.contains('text-[16px]')).toBe(true)
    // 前置的放大镜图标（输入框之前的那个 svg）
    expect(iconSize(input.parentElement!)).toBe('16')
  })

  it('FD-3 [white-box] flipping the ChatHost density on a mounted panel remounts the tree once, with the new density', async () => {
    await render({}, { density: 'compact' })
    expect(rec.mounts).toEqual(['compact'])
    const scans = scanDirCalls
    await render({}, { density: 'touch' })
    expect(rec.mounts).toEqual(['compact', 'touch'])
    expect(lastTree().density).toBe('touch')
    // 换档只重挂树，面板不重扫根目录
    expect(scanDirCalls).toBe(scans)
    // 同一档位再渲一次：不重挂
    await render({}, { density: 'touch' })
    expect(rec.mounts).toEqual(['compact', 'touch'])
  })
})
