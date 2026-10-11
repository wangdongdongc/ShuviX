/**
 * 一份注册表笔记的 md 扩展元数据视图（ChatApi `mdMeta.get`）—— 属性卡里两处共用：可改的补缺字段行
 * （FrontmatterFillField）与「ShuviX 设置」条（FrontmatterMetaStrip）。
 *
 * 挂上时问一次，写入队列（metaWriteQueue）每有变化再问；拿到结果后才 setState。最近一次的结果按会话缓存在
 * 模块里：卡片 widget 随 YAML 重建、槽位里的组件整个重挂，新实例先拿缓存画出来，不必空白一下。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getChatApi } from '@shuvix/chat-ui'
import type { MdMetaNoteView } from '@shuvix/chat-protocol/mdMeta'
import { metaWriteState, subscribeMetaWrites, type MetaWriteState } from './metaWriteQueue'

interface FetchedView {
  sessionId: string
  view: MdMetaNoteView | null
  /** 发起这次查询时写入队列的版本 */
  version: number
}

const lastViews = new Map<string, FetchedView>()

export interface MdMetaViewState {
  /** undefined = 还没问到（宿主没有 ChatApi.mdMeta 时一直如此）；null = 不是注册表笔记 / 查询失败 */
  view: MdMetaNoteView | null | undefined
  /** 这个会话写入队列的当前状态（在途的值、刚写进去的值、最近一次失败） */
  writes: MetaWriteState
  /** 视图是在队列最近一次变化之前问到的（重查还在路上）—— 这时以队列记的值为准，免得控件闪回旧值 */
  stale: boolean
  /** 主动重查一次（停用开关这类不经队列的写入之后） */
  refresh: () => void
}

export function useMdMetaView(sessionId: string): MdMetaViewState {
  const writes = useSyncExternalStore(
    (listener) => subscribeMetaWrites(sessionId, listener),
    () => metaWriteState(sessionId)
  )
  const [fetched, setFetched] = useState<FetchedView | null>(() => lastViews.get(sessionId) ?? null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const api = getChatApi().mdMeta
    if (!api) return undefined
    let alive = true
    const version = writes.version
    const settle = (view: MdMetaNoteView | null): void => {
      const next = { sessionId, view, version }
      const cached = lastViews.get(sessionId)
      if (!cached || cached.version <= version) lastViews.set(sessionId, next)
      if (alive) setFetched(next)
    }
    api.get({ sessionId }).then(settle, () => settle(null))
    return () => {
      alive = false
    }
  }, [sessionId, writes.version, nonce])

  // 换了会话就不拿上一个会话的视图来画
  const own = fetched?.sessionId === sessionId ? fetched : null
  return {
    view: own ? own.view : undefined,
    writes,
    stale: !own || own.version < writes.version,
    refresh: () => setNonce((n) => n + 1)
  }
}
