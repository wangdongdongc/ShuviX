/**
 * FilesTree — 文件树渲染容器(基于 @pierre/trees,path-first + Shadow DOM 隔离)。
 * 由 FilesPanel(右侧 Files 标签)与侧栏 WikiView 共用。
 * key 由父组件按 root 切换,保证不同工作目录间彻底重建模型;
 * 同一 root 下的增量更新通过 model.resetPaths 推送。
 *
 * 搜索过滤完全走 controller.setSearch / closeSearch,不启用库内置的 search input UI
 */

import { useEffect, useRef, useState } from 'react'
import { FileTree, useFileTreeSearch } from '@pierre/trees/react'
import { FileTree as FileTreeModel } from '@pierre/trees'

export function FilesTree({
  paths,
  searchQuery,
  onFileSelect,
  modelOutRef
}: {
  paths: string[]
  searchQuery: string
  /** 用户点击文件行（不含目录）时回调，传相对路径 */
  onFileSelect: (relPath: string) => void
  /** 让父组件持有 model 引用，用于关闭预览时 deselect */
  modelOutRef?: React.RefObject<FileTreeModel | null>
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
        // 紧凑布局，与侧边栏视觉密度对齐
        density: 'compact',
        itemHeight: 22
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
  // 字号 / 行高 / 横向内边距 进一步压缩，对齐侧边栏密度（text-[12px] + px-1.5 风格）
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
    // 字体与字号 — 与侧边栏对齐
    '--trees-font-size-override': '12px',
    '--trees-font-family-override': 'inherit',
    // 横向内边距 — 默认 16px 偏宽，压到 8px
    '--trees-padding-inline-override': '8px',
    // 缩进每层 12px，跟侧边栏 ml-1.5 / pl-0.5 相近
    '--trees-level-gap-override': '12px'
  } as React.CSSProperties

  return <FileTree model={model} style={treeStyle} />
}
