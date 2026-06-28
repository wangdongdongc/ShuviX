import { getChannelBindingApi } from '@shuvix/chat-ui'

/**
 * 会话渠道绑定能力探测 —— 单一来源。
 *
 * 「会话绑定」相关 UI（设置页的 BindingsSettings、会话设置的 SessionConfigPanel 分节）
 * 不再各自硬编码渠道开关，而是统一据 getChannelBindingApi() 探测当前宿主提供了哪些渠道，
 * 自动显隐：
 *   - 桌面端 window.api 自带 webui + telegram → 两者皆显示；
 *   - 扩展端若只 setChannelBindingApi({ telegram }) → 仅 telegram 显示，webui 自动隐藏；
 *   - 未提供任何渠道 → 整个「会话绑定」分节 / 设置 Tab 隐藏（any 为 false）。
 */
export type ChannelId = 'webui' | 'telegram'

export interface ChannelBindingCaps {
  /** WebUI / 局域网共享渠道可用 */
  webui: boolean
  /** Telegram Bot 渠道可用 */
  telegram: boolean
  /** 是否存在任一渠道（决定整个绑定分节 / 设置 Tab 是否出现） */
  any: boolean
}

/** 同步探测当前宿主支持的渠道绑定能力（注入是启动期静态的，可在 render 中直接调用）。 */
export function getChannelBindingCaps(): ChannelBindingCaps {
  const api = getChannelBindingApi()
  const webui = !!api?.webui
  const telegram = !!api?.telegram
  return { webui, telegram, any: webui || telegram }
}
