/**
 * FilesTree — 文件树渲染容器(基于 @pierre/trees,path-first + Shadow DOM 隔离)。
 * 由 FilesPanel(右侧 Files 标签)使用。
 * key 由父组件按 root 切换,保证不同工作目录间彻底重建模型;
 * 同一 root 下的增量更新通过 model.resetPaths 推送。
 *
 * 懒加载模式（可选）：传入 onRequestChildren 时，订阅 model 变化 diff 出「新展开且尚未
 * 加载过的目录」，回调拿回路径后用 model.batch 增量注入（同一目录并发展开只请求一次，
 * 失败在下次展开时重试）。不传则保持全量 paths 行为完全不变。
 *
 * 搜索过滤完全走 controller.setSearch / closeSearch,不启用库内置的 search input UI
 *
 * 右键菜单（可选）：传入 onItemContextMenu 时经 pierre React 组件的 renderContextMenu 打开右键触发，
 * 菜单本身不让 pierre 画 —— 它的菜单槽里只挂一个不渲染任何东西的 ContextMenuHandoff，挂上就把条目与
 * 位置交给宿主的 useContextMenu 弹（桌面原生菜单 / 手机长按的 DOM 菜单），菜单收起后再关 pierre 的
 * 菜单态，行在菜单开着时保持高亮。
 */

import { useEffect, useRef, useState } from 'react'
import { FileTree, useFileTreeSearch } from '@pierre/trees/react'
import {
  FileTree as FileTreeModel,
  type ContextMenuItem as PierreMenuItem,
  type ContextMenuOpenContext
} from '@pierre/trees'
import { deriveDirPaths, LazyLoadTracker } from './lazyTree'

/**
 * 常显滚动条补丁 —— pierre 默认把 thumb 设为 transparent、hover 才现（且色值是它自己的
 * 25% fg 混色，与 ShuviX 的 .thin-scrollbar 明显不同）。面板/右栏里的文件树与对话列并排，
 * 两种滚动条同框出现观感割裂，故经 unsafeCSS（注入 shadow root 的 @layer unsafe）把
 * thumb 钉成常显；颜色另经 --trees-scrollbar-thumb-override 对齐（见 treeStyle）。
 */
const PERSISTENT_SCROLLBAR_CSS = `[data-file-tree-virtualized-scroll="true"] {
  --trees-scrollbar-thumb-current: var(--trees-scrollbar-thumb);
}`

/**
 * 两档密度：compact = 桌面，对齐侧栏桌面档的紧凑感；touch = 手机，对齐侧栏 touch 档（app-shell
 * base.css `[data-sidebar-density='touch']`：40px 一行、19px 图标、10px 圆角）。树在 Shadow DOM 里，
 * 手机布局按设备字号放大小字的那组规则（main.css `[data-mobile-scale]`）进不去，所以字号在这里定：
 * 手机上取设备字号 --app-font-size（缺省 16，与侧栏 touch 档同号）—— 自定义属性能继承进 shadow root。
 * 行高是 pierre 虚拟列表的计算依据，只能在构造 model 时给，故密度是挂载期决定的。
 */
export type FilesTreeDensity = 'compact' | 'touch'

const DENSITY_MODEL = {
  compact: { density: 'compact', itemHeight: 22 },
  touch: { density: 'relaxed', itemHeight: 40 }
} as const

const DENSITY_STYLE: Record<FilesTreeDensity, Record<string, string>> = {
  compact: {
    // 字号与侧边栏对齐；横向内边距默认 16px 偏宽，压到 8px；缩进每层 12px，跟侧边栏 ml-1.5 / pl-0.5 相近
    '--trees-font-size-override': '12px',
    '--trees-padding-inline-override': '8px',
    '--trees-level-gap-override': '12px'
  },
  touch: {
    '--trees-font-size-override': 'var(--app-font-size, 16px)',
    '--trees-icon-width-override': '19px',
    '--trees-padding-inline-override': '8px',
    '--trees-level-gap-override': '16px',
    '--trees-item-row-gap-override': '10px',
    '--trees-border-radius-override': '10px'
  }
}

/** 右键（手机长按）一个条目：path 为树内相对路径（目录不带尾斜杠），position 为菜单弹出点（客户端坐标） */
export interface FilesTreeContextMenuItem {
  path: string
  kind: 'file' | 'directory'
}

type ItemContextMenuHandler = (
  item: FilesTreeContextMenuItem,
  position: { x: number; y: number }
) => Promise<void | 'focus-moved'> | void

/**
 * pierre 打开菜单态时挂进它的菜单槽：自己不渲染，挂上就把条目交给宿主弹菜单，等菜单收起（动作做完）再关
 * pierre 的菜单态。每次打开都是新挂载（关了槽就清掉）；StrictMode 下 effect 会多跑一遍而组件并没卸载 ——
 * 只弹一次。
 */
function ContextMenuHandoff({
  item,
  context,
  onOpen
}: {
  item: PierreMenuItem
  context: ContextMenuOpenContext
  onOpen: ItemContextMenuHandler
}): null {
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const r = context.anchorRect
    // 右键给的是光标点（高 0）；键盘（Shift+F10 / 菜单键）给的是行框 —— 贴着行的下沿弹
    const position = { x: r.left, y: r.height > 0 ? r.bottom : r.top }
    const path = item.path.replace(/\/+$/, '')
    void Promise.resolve(onOpen({ path, kind: item.kind }, position))
      .catch(() => undefined)
      .then((res) => context.close({ restoreFocus: res !== 'focus-moved' }))
  }, [item, context, onOpen])
  return null
}

export function FilesTree({
  paths,
  searchQuery,
  onFileSelect,
  modelOutRef,
  persistentScrollbar,
  onRequestChildren,
  density = 'compact',
  onItemContextMenu
}: {
  paths: string[]
  searchQuery: string
  /** 用户点击文件行（不含目录）时回调，传相对路径 */
  onFileSelect: (relPath: string) => void
  /** 让父组件持有 model 引用，用于关闭预览时 deselect */
  modelOutRef?: React.RefObject<FileTreeModel | null>
  /** 滚动条常显（与对话列的 .thin-scrollbar 同款）；缺省沿用 pierre 的 hover 才现 */
  persistentScrollbar?: boolean
  /**
   * 懒加载模式：目录首次展开时回调（dirRelPath 无尾斜杠），返回要注入的完整相对路径
   * 列表（含子目录尾斜杠条目）。不传 = 全量 paths 模式。抛错视为失败，下次展开重试。
   */
  onRequestChildren?: (dirRelPath: string) => Promise<string[]>
  /** 行高 / 字号档位（挂载期决定，换档要换 key 重挂）；缺省 compact */
  density?: FilesTreeDensity
  /**
   * 右键（手机长按）一个条目时回调；返回的 Promise 结束（菜单收起、动作做完）后 pierre 的菜单态才关，
   * 期间该行保持高亮。关闭时焦点回到这一行（键盘用户接着走），除非 resolve 为 'focus-moved' ——
   * 动作把焦点交给了别处（如输入框），不能再抢回来。不传 = 浏览器默认右键。
   */
  onItemContextMenu?: ItemContextMenuHandler
}): React.JSX.Element {
  // 用 ref 持有最新回调，组件保留 mount 时的 model 实例
  const onSelectRef = useRef(onFileSelect)
  useEffect(() => {
    onSelectRef.current = onFileSelect
  }, [onFileSelect])

  // 模型自持（useState 惰性初始化），不用库的 useFileTree —— 后者在 effect cleanup 里
  // 把内部 ref 置空，而 React StrictMode 对每个新挂载组件做「模拟卸载 → 立即重挂载」：
  // cleanup 跑完组件仍挂载、ref 却已为空，于是**此后任意一次 re-render** 都会静默 new 出
  // 一个全新 model（initialExpansion: 'closed'），整树展开状态被清空。表现即「首次点文件
  // 预览时整树折叠」—— 那一下预览请求打开了 app 级右侧面板，ChatView → FilesPanel →
  // FilesTree 第一次 re-render；新 model 落位后 ref 不再为空，所以只错一次、之后都正常。
  // useState 的值在整个挂载期恒定，re-render 不会重建模型。
  const [model] = useState(
    () =>
      new FileTreeModel({
        paths,
        initialExpansion: 'closed',
        dragAndDrop: false,
        flattenEmptyDirectories: true,
        ...DENSITY_MODEL[density],
        ...(persistentScrollbar ? { unsafeCSS: PERSISTENT_SCROLLBAR_CSS } : {})
      })
  )

  // 释放：cleanUp() 会摧毁 controller 对 store 的订阅（此后展开/折叠不再触发重绘），
  // 而 StrictMode 的模拟卸载紧跟着同一次 commit 内的重挂载 —— 故销毁延到下一个宏任务，
  // 由重挂载的 setup 顺手撤销。真卸载没有后续 setup，定时器如期执行。
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (disposeTimer.current) {
      clearTimeout(disposeTimer.current)
      disposeTimer.current = null
    }
    return () => {
      disposeTimer.current = setTimeout(() => {
        disposeTimer.current = null
        model.cleanUp()
      }, 0)
    }
  }, [model])

  // 把 model 暴露给父组件 —— 关闭预览时父组件需要 deselect
  useEffect(() => {
    if (!modelOutRef) return
    modelOutRef.current = model
    return () => {
      modelOutRef.current = null
    }
  }, [model, modelOutRef])

  // 选择订阅 —— 不能用 useFileTree options 里的 onSelectionChange（pierre 只在 model
  // 构造时消费一次）；也不用 useFileTreeSelection 包装（useSyncExternalStore 的订阅在
  // mount 之后才挂上去，且内部 selector 每次渲染都是新函数会破坏其缓存，导致 workspace
  // 切换后首次 click 偶发性丢失）。直接 model.subscribe 是最稳的路径：mount 即时挂载，
  // pierre 内部已经吃掉 initial snapshot 不会回调一次空选区，关闭闭包变量 lastNotified
  // 在 unmount 时随 cleanup 一起释放，无跨 mount 状态泄漏。
  useEffect(() => {
    let lastNotified: string | null = model.getSelectedPaths()[0] ?? null
    const unsubscribe = model.subscribe(() => {
      const p = model.getSelectedPaths()[0] ?? null
      if (lastNotified === p) return
      lastNotified = p
      if (!p) return
      const item = model.getItem(p)
      // 目录交给树自身展开/收起，不进预览
      if (!item || item.isDirectory()) return
      onSelectRef.current(p)
    })
    return unsubscribe
  }, [model])

  // —— 懒加载：新展开的目录 → 回调取路径 → model.batch 增量注入 ——
  // 回调走 ref（与 onSelectRef 同理），订阅只挂一次；tracker/knownDirs/expanded 用
  // useState 惰性初始化自持 —— StrictMode 模拟卸载重挂载时 useRef 惰性值会随首跑
  // cleanup 丢失重建，展开中途的 inflight 状态不能丢（否则同一目录重复请求）。
  const requestRef = useRef(onRequestChildren)
  useEffect(() => {
    requestRef.current = onRequestChildren
  }, [onRequestChildren])
  const [lazyState] = useState(() => ({
    tracker: new LazyLoadTracker(),
    knownDirs: deriveDirPaths(paths),
    expanded: new Set<string>()
  }))
  useEffect(() => {
    if (!onRequestChildren) return // 全量模式：行为完全不变
    const { tracker, knownDirs } = lazyState
    const syncExpanded = (): void => {
      const now = new Set<string>()
      for (const dir of knownDirs) {
        const item = model.getItem(dir)
        if (item && 'isExpanded' in item && item.isExpanded()) now.add(dir)
      }
      const prev = lazyState.expanded
      const newly: string[] = []
      for (const dir of now) {
        if (!prev.has(dir)) newly.push(dir)
      }
      lazyState.expanded = now
      for (const dir of newly) {
        if (!tracker.shouldRequest(dir)) continue
        requestRef
          .current?.(dir.replace(/\/+$/, ''))
          .then((newPaths) => {
            tracker.markLoaded(dir)
            if (newPaths.length === 0) return
            model.batch(newPaths.map((p) => ({ type: 'add' as const, path: p })))
            for (const d of deriveDirPaths(newPaths)) knownDirs.add(d)
          })
          .catch(() => tracker.markFailed(dir))
      }
    }
    return model.subscribe(syncExpanded)
  }, [model, onRequestChildren, lazyState])

  // 首批 paths 已由模型构造函数消费；后续 paths 变化通过 resetPaths 同步。
  // resetPaths 是整树重建（选中有迁移逻辑，展开状态没有）—— 不带 initialExpandedPaths
  // 会全部收起，因此重建前逐目录读出当前展开状态原样带过去。目录集合从新 paths 推导
  // （已删除的目录无需保留；新增目录在旧模型里查不到句柄，自然跳过）。
  // 以「上次同步过的 paths 引用」判定而非 isFirst 布尔：StrictMode 下 effect 会双跑，
  // 布尔标记会被首跑吃掉，第二跑就误触发一次多余的整树重建。
  const appliedPaths = useRef(paths)
  useEffect(() => {
    if (appliedPaths.current === paths) return
    appliedPaths.current = paths
    const dirs = new Set<string>()
    for (const p of paths) {
      const segments = p.split('/')
      for (let i = 1; i < segments.length; i++) {
        dirs.add(`${segments.slice(0, i).join('/')}/`) // pierre 目录规范路径带尾斜杠
      }
    }
    const expanded: string[] = []
    for (const dir of dirs) {
      const item = model.getItem(dir)
      if (item && 'isExpanded' in item && item.isExpanded()) expanded.push(dir)
    }
    model.resetPaths(paths, { initialExpandedPaths: expanded })
  }, [paths, model])

  // 把外部搜索查询透传到 controller —— 空串视作关闭搜索
  // 库内部在点击行时会强制 closeSearch（fileTreeRowClickPlan.js: closeSearch: isSearchOpen），
  // 因此订阅 isOpen，一旦库自行关闭而我们仍有查询，立刻重新 setSearch 恢复过滤
  const { isOpen: libraryIsOpen } = useFileTreeSearch(model)
  useEffect(() => {
    if (searchQuery) {
      if (!libraryIsOpen) model.setSearch(searchQuery)
      else if (model.getSearchValue() !== searchQuery) model.setSearch(searchQuery)
    } else if (libraryIsOpen) {
      model.closeSearch()
    }
  }, [searchQuery, libraryIsOpen, model])

  // 把 ShuviX 主题 CSS 变量桥接到 @pierre/trees 的覆盖变量
  const treeStyle = {
    height: '100%',
    width: '100%',
    // 颜色
    '--trees-bg-override': 'var(--color-bg-secondary)',
    '--trees-fg-override': 'var(--color-text-primary)',
    '--trees-fg-muted-override': 'var(--color-text-secondary)',
    '--trees-selected-bg-override': 'var(--color-bg-active)',
    '--trees-border-color-override': 'var(--color-border-secondary)',
    '--trees-accent-override': 'var(--color-accent)',
    // 滚动条 thumb 与 .thin-scrollbar 取同一色（pierre 默认是 25% fg 的不透明混色）；
    // 宽度不用改：默认 gutter 6px 里 thumb 带 1px 透明边 + content-box 裁切，实际就是 4px
    '--trees-scrollbar-thumb-override':
      'color-mix(in srgb, var(--color-border-primary) 40%, transparent)',
    '--trees-font-family-override': 'inherit',
    // 字号 / 内边距 / 缩进按密度（见 DENSITY_STYLE）
    ...DENSITY_STYLE[density]
  } as React.CSSProperties

  return (
    <FileTree
      model={model}
      style={treeStyle}
      // 开着菜单态时 pierre 的触发方式缺省就是只认右键（不画行尾的 ⋮ 按钮）
      renderContextMenu={
        onItemContextMenu
          ? (item, context) => (
              <ContextMenuHandoff item={item} context={context} onOpen={onItemContextMenu} />
            )
          : undefined
      }
    />
  )
}
