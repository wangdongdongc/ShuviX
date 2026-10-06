/**
 * 侧边栏重连之后的视图重绑（P3-09 PIN-10）。
 *
 * 桌面那头的订阅属于某一条桥连接（客户端 `chrome:<connId>`）：桌面重启、本地组件重连、连接被顶替，都会
 * 先让连接状态离开 `ready`，再回到 `ready` —— 那时旧客户端连同它的订阅已经不在了，新连接上什么都没订。
 * 所以每次「非 ready → ready」都让 syncClient 丢掉全部绑定（不发退订：那一端已经不在了）、按还有人持有的
 * 目标重新订阅，拿一份新快照；旧订阅迟到的帧随之成了孤儿，被丢掉。
 *
 * 第一次就绪不算重连（那时还没有任何绑定）。
 */
import type { PanelLinkState } from '../shared/panelLink'

/** 连接里要的那一点（PanelLink 满足它） */
export interface ResettableLink {
  readonly state: PanelLinkState
  onState(listener: (state: PanelLinkState) => void): () => void
}

/** 重连时要重置的客户端（chat-ui syncClient 满足它） */
export interface ResettableSyncClient {
  resetAll(): void
}

/** 登记重绑；返回注销 */
export function resetSyncOnReconnect(
  link: ResettableLink,
  client: ResettableSyncClient
): () => void {
  let everReady = link.state === 'ready'
  let lost = false
  return link.onState((state) => {
    if (state !== 'ready') {
      if (everReady) lost = true
      return
    }
    everReady = true
    if (!lost) return
    lost = false
    client.resetAll()
  })
}
