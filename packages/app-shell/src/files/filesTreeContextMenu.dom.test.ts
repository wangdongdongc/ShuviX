// @vitest-environment jsdom
/**
 * FilesTree 的右键菜单交接与两档密度（jsdom）。
 *
 * 契约（FilesTree.tsx 头注释 + props 注释）：传 onItemContextMenu 时经 pierre React 组件的 renderContextMenu
 * 打开右键；菜单槽里挂的东西自己不画任何东西，挂上就把条目（树内相对路径，目录不带尾斜杠）与弹出点交给
 * 回调；回调返回的 Promise 结束后才关 pierre 的菜单态 —— resolve 为 'focus-moved' 时不把焦点抢回这一行，
 * 其余（undefined、reject、同步返回）都还给它。不传 = 浏览器默认右键（不给 renderContextMenu）。
 * 密度是挂载期定的：compact = 桌面（22px 行、12px 字），touch = 手机（pierre relaxed、40px 行、设备字号）。
 *
 * pierre 的 React 组件桩掉（只记 props，不渲染）—— renderContextMenu 由用例自己调、渲染进另一个 root；
 * model 用真的 FileTree 子类，记下构造参数。文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），一律 createElement。
 *
 *   FT-1 不传 onItemContextMenu → renderContextMenu 为 undefined
 *   FT-2 目录 'docs/sub/'：渲染出的东西为空；onOpen 恰一次，路径去尾斜杠、弹出点 = 光标点（高 0 → top）
 *   FT-3 anchorRect 有高度（键盘打开）→ 贴着行的下沿（bottom）弹
 *   FT-4 close 的时机与 restoreFocus：Promise 未结束前不关；'focus-moved' → false；undefined / reject / 同步
 *        返回 → true
 *   FT-5 [白盒] StrictMode 下也只有一次 onOpen、一次 close
 *   FT-6 [白盒] 同一个挂着的交接组件换了个 context 重渲：不再 onOpen
 *   FT-7 密度：缺省 / compact → model { density:'compact', itemHeight:22 } + 12px / 8px / 12px；
 *        touch → { density:'relaxed', itemHeight:40 } + 设备字号、19px 图标、10px 行距、10px 圆角
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement, StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ContextMenuItem, ContextMenuOpenContext } from '@pierre/trees'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type CloseFn = ContextMenuOpenContext['close']
type RenderContextMenu = (item: ContextMenuItem, context: ContextMenuOpenContext) => ReactNode

const rec = vi.hoisted(() => ({
  /** 桩 FileTree 每次渲染收到的 props */
  treeProps: [] as Array<{ renderContextMenu?: unknown; style?: Record<string, unknown> }>,
  /** 真 model 子类的构造参数 */
  modelOptions: [] as Array<Record<string, unknown>>
}))

vi.mock('@pierre/trees/react', () => ({
  FileTree: (props: { renderContextMenu?: unknown; style?: Record<string, unknown> }) => {
    rec.treeProps.push(props)
    return null
  },
  useFileTreeSearch: () => ({ isOpen: false })
}))

vi.mock('@pierre/trees', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@pierre/trees')>()
  class RecordingFileTree extends orig.FileTree {
    constructor(options: ConstructorParameters<typeof orig.FileTree>[0]) {
      super(options)
      rec.modelOptions.push(options as unknown as Record<string, unknown>)
    }
  }
  return { ...orig, FileTree: RecordingFileTree }
})

import { FilesTree, type FilesTreeDensity } from './FilesTree'

type FilesTreeProps = Parameters<typeof FilesTree>[0]
type Handler = NonNullable<FilesTreeProps['onItemContextMenu']>

let container: HTMLDivElement
let root: Root
/** 交接组件渲染进的另一个 root（pierre 的菜单槽） */
let slot: HTMLDivElement
let slotRoot: Root

beforeEach(() => {
  rec.treeProps.length = 0
  rec.modelOptions.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  slot = document.createElement('div')
  document.body.appendChild(slot)
  slotRoot = createRoot(slot)
})

afterEach(() => {
  act(() => slotRoot.unmount())
  act(() => root.unmount())
  container.remove()
  slot.remove()
})

function renderTree(props: Partial<FilesTreeProps> = {}): void {
  act(() => {
    root.render(
      createElement(FilesTree, {
        paths: ['a.txt', 'docs/', 'docs/sub/', 'docs/sub/b.md'],
        searchQuery: '',
        onFileSelect: () => {},
        ...props
      })
    )
  })
}

const lastProps = (): (typeof rec.treeProps)[number] => {
  const p = rec.treeProps.at(-1)
  if (!p) throw new Error('FileTree stub never rendered')
  return p
}

const renderContextMenuProp = (): RenderContextMenu => {
  const fn = lastProps().renderContextMenu
  if (typeof fn !== 'function') throw new Error('renderContextMenu not passed')
  return fn as RenderContextMenu
}

const DIR_ITEM: ContextMenuItem = { kind: 'directory', name: 'sub', path: 'docs/sub/' }
const FILE_ITEM: ContextMenuItem = { kind: 'file', name: 'b.md', path: 'docs/sub/b.md' }

function rect(r: {
  left: number
  top: number
  bottom: number
  height: number
}): ContextMenuOpenContext['anchorRect'] {
  return { ...r, right: r.left, width: 0, x: r.left, y: r.top }
}

function makeContext(
  r: { left: number; top: number; bottom: number; height: number } = {
    left: 10,
    top: 20,
    bottom: 20,
    height: 0
  }
): ContextMenuOpenContext & { close: Mock<CloseFn> } {
  return {
    anchorElement: document.createElement('div'),
    anchorRect: rect(r),
    close: vi.fn<CloseFn>(),
    restoreFocus: vi.fn()
  }
}

/** 把菜单槽的内容渲染进 slot（可选 StrictMode） */
function renderSlot(node: ReactNode, strict = false): void {
  act(() => {
    slotRoot.render(strict ? createElement(StrictMode, null, node) : node)
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 一个手动结束的 Promise */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('FilesTree context-menu hand-off', () => {
  it('FT-1 without onItemContextMenu there is no renderContextMenu (browser default)', () => {
    renderTree()
    expect(rec.treeProps.length).toBeGreaterThan(0)
    expect(lastProps().renderContextMenu).toBeUndefined()
  })

  it('FT-2 a directory item renders nothing and is handed over once: path without the trailing slash, cursor point', async () => {
    const onOpen = vi.fn<Handler>(async () => undefined)
    renderTree({ onItemContextMenu: onOpen })
    const ctx = makeContext()
    renderSlot(renderContextMenuProp()(DIR_ITEM, ctx))
    await flush()
    expect(slot.innerHTML).toBe('')
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith({ path: 'docs/sub', kind: 'directory' }, { x: 10, y: 20 })
  })

  it('FT-3 an anchor rect with a height (keyboard) opens at the row’s bottom edge', async () => {
    const onOpen = vi.fn<Handler>(async () => undefined)
    renderTree({ onItemContextMenu: onOpen })
    renderSlot(
      renderContextMenuProp()(FILE_ITEM, makeContext({ left: 10, top: 20, bottom: 42, height: 22 }))
    )
    await flush()
    expect(onOpen).toHaveBeenCalledWith({ path: 'docs/sub/b.md', kind: 'file' }, { x: 10, y: 42 })
  })

  describe('FT-4 when and how the pierre menu state is closed', () => {
    it("is not closed while the handler's promise is pending; 'focus-moved' → restoreFocus false", async () => {
      const d = deferred<void | 'focus-moved'>()
      const onOpen = vi.fn<Handler>(() => d.promise)
      renderTree({ onItemContextMenu: onOpen })
      const ctx = makeContext()
      renderSlot(renderContextMenuProp()(FILE_ITEM, ctx))
      await flush()
      expect(onOpen).toHaveBeenCalledTimes(1)
      expect(ctx.close).not.toHaveBeenCalled()
      d.resolve('focus-moved')
      await flush()
      expect(ctx.close).toHaveBeenCalledTimes(1)
      expect(ctx.close).toHaveBeenCalledWith({ restoreFocus: false })
    })

    it.each<[string, () => Handler]>([
      ['resolves undefined', () => async () => undefined],
      ['rejects', () => async () => Promise.reject(new Error('menu failed'))],
      ['returns void synchronously', () => () => undefined]
    ])('%s → restoreFocus true', async (_, make) => {
      const onOpen = vi.fn<Handler>(make())
      renderTree({ onItemContextMenu: onOpen })
      const ctx = makeContext()
      renderSlot(renderContextMenuProp()(FILE_ITEM, ctx))
      await flush()
      expect(onOpen).toHaveBeenCalledTimes(1)
      expect(ctx.close).toHaveBeenCalledTimes(1)
      expect(ctx.close).toHaveBeenCalledWith({ restoreFocus: true })
    })
  })

  it('FT-5 [white-box] under StrictMode exactly one onOpen and one close', async () => {
    const onOpen = vi.fn<Handler>(async () => undefined)
    renderTree({ onItemContextMenu: onOpen })
    const ctx = makeContext()
    renderSlot(renderContextMenuProp()(DIR_ITEM, ctx), true)
    await flush()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(ctx.close).toHaveBeenCalledTimes(1)
  })

  it('FT-6 [white-box] re-rendering the mounted hand-off with a new context object does not hand over again', async () => {
    const onOpen = vi.fn<Handler>(async () => undefined)
    renderTree({ onItemContextMenu: onOpen })
    const render = renderContextMenuProp()
    renderSlot(render(FILE_ITEM, makeContext()))
    await flush()
    renderSlot(render(FILE_ITEM, makeContext()))
    await flush()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('FT-7 density', () => {
  const COMPACT_STYLE = {
    '--trees-font-size-override': '12px',
    '--trees-padding-inline-override': '8px',
    '--trees-level-gap-override': '12px'
  }

  it.each<[string, FilesTreeDensity | undefined]>([
    ['default', undefined],
    ['compact', 'compact']
  ])('%s → compact model and desktop sizes', (_, density) => {
    renderTree(density ? { density } : {})
    expect(rec.modelOptions).toHaveLength(1)
    expect(rec.modelOptions[0]).toMatchObject({ density: 'compact', itemHeight: 22 })
    expect(lastProps().style).toMatchObject(COMPACT_STYLE)
    // 触屏档的那几项不出现在桌面档上
    expect(lastProps().style).not.toHaveProperty('--trees-icon-width-override')
    expect(lastProps().style).not.toHaveProperty('--trees-item-row-gap-override')
  })

  it("touch → pierre 'relaxed', 40px rows, the device font size, 19px icons, 10px row gap and radius", () => {
    renderTree({ density: 'touch' })
    expect(rec.modelOptions).toHaveLength(1)
    expect(rec.modelOptions[0]).toMatchObject({ density: 'relaxed', itemHeight: 40 })
    expect(lastProps().style).toMatchObject({
      '--trees-font-size-override': 'var(--app-font-size, 16px)',
      '--trees-icon-width-override': '19px',
      '--trees-item-row-gap-override': '10px',
      '--trees-border-radius-override': '10px'
    })
  })
})
