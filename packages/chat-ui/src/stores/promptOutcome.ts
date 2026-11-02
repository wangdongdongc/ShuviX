/**
 * 一条消息发出去之后连接断了、还没看到它被受理：等连回来，看视图里有没有它。
 *
 * `agent.prompt` 因断线被拒只说明「这边没等到结果」—— 消息可能已经到了服务端、这一轮正跑着，也可能停在半开的 socket
 * 里没送到。能回答的只有视图：连回来之后视图重新同步，里面出现发送时还没有的用户消息，乐观占位就被撤下（PIN-17）。
 *
 * 宽限只算**看得见视图**的时间，从看得见的那一刻算起：连接断着不算（手机切到后台时定时器会停，从断线算起的话一回前台
 * 就先判成「没送到」），用户在别的会话也不算（只有当前会话订着视图，这时判不出来，回来再说）。服务端受理之前可能还在
 * 建运行时（MCP 惰性连接单个封顶 5s），所以宽限留得比它久；宽限过后才到的话，话已经放回输入框 —— 代价是用户看到两份，
 * 好过把没送到的话弄丢。「受理」沿用占位的判定（视图里出现新的用户消息），所以等待期间别的设备发来一句，也算受理了。
 */
import type { SyncLinkChannel } from '@shuvix/chat-protocol/sync'
import { useChatStore } from './chatStore'

export const PROMPT_OUTCOME_GRACE_MS = 15_000

/** 这条会话的消息是否已被受理（占位已撤）。不改任何状态：占位由发送方自己收尾 */
export function waitForPromptOutcome(
  sessionId: string,
  link: Pick<SyncLinkChannel, 'isUp' | 'onUp' | 'onDown'>,
  graceMs: number = PROMPT_OUTCOME_GRACE_MS
): Promise<boolean> {
  const accepted = (): boolean => !useChatStore.getState().sessionPendingPrompt[sessionId]
  if (accepted()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let up = link.isUp?.() !== false
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const update = (): void => {
      if (accepted()) return finish(true)
      if (!up || useChatStore.getState().activeSessionId !== sessionId) return stopTimer()
      timer ??= setTimeout(() => finish(false), graceMs)
    }
    const stops = [
      useChatStore.subscribe(update),
      link.onUp?.(() => {
        up = true
        stopTimer()
        update()
      }),
      link.onDown?.(() => {
        up = false
        update()
      })
    ]
    function finish(outcome: boolean): void {
      stopTimer()
      for (const stop of stops) stop?.()
      resolve(outcome)
    }
    update()
  })
}
