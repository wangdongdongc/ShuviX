import { useCallback, useEffect } from 'react'
import { getChatApi, useAppEvent, useBgTaskStore } from '@shuvix/chat-ui'

/**
 * 补侧栏的「后台任务还在跑」。`bg_task` 是事件，窗口重建、web 客户端连上来之前发的都错过了，而切会话时的快照
 * 只补当前那一条（useSessionInit）—— 别的会话的后台任务就看不出来。所以挂载时取一份，`session.listChanged` 时
 * 再取一份：web 客户端重连后补发的信号事件里有它，断线期间已经结束的任务也随之落定，不会一直显示在跑。
 *
 * 时序同 useAskCountSeed：应答与事件走同一条有序的连接。取失败就保持现状，等下一个事件。
 */
export function useBgTaskSeed(): void {
  const refetch = useCallback(() => {
    void getChatApi()
      .bgTask.listAll()
      .then((tasks) => useBgTaskStore.getState().replaceAll(tasks))
      .catch(() => {
        /* 保持现状 */
      })
  }, [])
  useEffect(refetch, [refetch])
  useAppEvent('session.listChanged', refetch)
}
