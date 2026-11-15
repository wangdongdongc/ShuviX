import { useEffect, useRef } from 'react'

/** 浏览器历史里标记「这一条是叠放设置往下钻时压的」；值是钻到了第几层（1 = 分区，2 = 分区里的一项） */
export const STACKED_SETTINGS_HISTORY_MARK = 'shuvixSettingsDepth'

const markOf = (state: unknown): number => {
  const value = (state as Record<string, unknown> | null)?.[STACKED_SETTINGS_HISTORY_MARK]
  return typeof value === 'number' ? value : 0
}

/**
 * 叠放设置（手机布局）的层数接到浏览器历史上：往下钻一层压一条，返回键 / 返回手势退一条就是退一层。
 *
 * - `depth` 变深（列表 → 分区 → 分区里的一项）：每深一层压一条，条目照样带着下面那几层的记号；
 * - `depth` 变浅（点了顶栏的返回、或那一项没了）：这一层是这里压的就退掉那一条；
 * - 返回手势（popstate）：历史上的层数比此刻浅 → `onPopTo(层数)`，由调用方把界面退到那一层。
 *
 * 挂上那一刻的层数是基线（地址栏的 hash 直接点名了某个分区时一挂上就在第 1 层），基线以内不压也不退。
 */
export function useStackedHistory(
  enabled: boolean,
  depth: number,
  onPopTo: (depth: number) => void
): void {
  const base = useRef(depth)
  const last = useRef(depth)
  // 历史此刻在（或已经要求它退到）第几层：浏览器的回退是异步的，连着两次变浅时第二次读到的 history.state 还是旧的
  const pending = useRef(depth)
  const onPopToRef = useRef(onPopTo)
  useEffect(() => {
    onPopToRef.current = onPopTo
  })

  // 重新加载后留在当前条目上的旧记号（页面已经不在那一层了）：摘掉，免得之后要多退一次
  useEffect(() => {
    if (!enabled) return
    const state = window.history.state as Record<string, unknown> | null
    if (markOf(state) <= base.current) return
    const rest = { ...state }
    delete rest[STACKED_SETTINGS_HISTORY_MARK]
    window.history.replaceState(Object.keys(rest).length > 0 ? rest : null, '')
    // 只在挂上那一刻做一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!enabled) return
    const prev = last.current
    last.current = depth
    if (depth > prev) {
      for (let level = prev + 1; level <= depth; level++) {
        if (level <= base.current) continue
        window.history.pushState(
          {
            ...((window.history.state as Record<string, unknown> | null) ?? {}),
            [STACKED_SETTINGS_HISTORY_MARK]: level
          },
          ''
        )
        pending.current = level
      }
    } else if (depth < prev) {
      // 这一层是这里压的、历史此刻还停在它上面：退掉（popstate 回来时层数已经对上，不再动）。已经要求退掉、
      // 还没退完的那几条不重复算
      const here = Math.min(markOf(window.history.state), pending.current)
      const target = Math.max(depth, base.current)
      if (here > target) {
        pending.current = target
        window.history.go(-(here - target))
      }
    }
  }, [enabled, depth])

  useEffect(() => {
    if (!enabled) return
    const onPop = (): void => {
      const target = Math.max(markOf(window.history.state), base.current)
      pending.current = target
      if (target < last.current) onPopToRef.current(target)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [enabled])
}
