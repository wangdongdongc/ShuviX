/**
 * ChannelBindingApi —— 会话「外联 / 渠道绑定」契约，与 ChatApi（对话渲染契约）正交的一条轴。
 *
 * ChatApi 负责「渲染并驱动一个会话」，所有宿主必须实现；
 * ChannelBindingApi 负责「把某个会话从当前宿主 fan-out 到其它投递渠道」
 * （局域网 WebUI 广播 / Telegram Bot），是一项**可选的宿主能力**：
 *   - 桌面端（Electron main 跑 Node）可提供 webui + telegram；
 *   - Chrome 扩展（MV3 无法监听端口）不提供 webui，可提供出站 telegram；
 *   - 纯前端宿主可二者皆不提供。
 *
 * 每个渠道均为可选成员，宿主按自身能力提供其一 / 其全 / 皆无。
 * chat-ui 通过 getChannelBindingApi() 取实现（可能为 null），消费方须做能力降级。
 *
 * 参数 / 数据形状沿用 chatApi.ts 中的对应类型（前↔后端协议单一来源）。
 */
import type {
  TelegramBotInfo,
  TelegramBotAddParams,
  TelegramBotUpdateParams,
  TelegramBindSessionParams,
  TelegramUnbindSessionParams
} from './chatApi'

/**
 * WebUI / 局域网共享：把会话经本地 HTTP 服务广播给同网设备（宿主需能跑监听端口的 server）。
 * 分享一律为「仅查看」——同网设备只能查看会话现存内容（消息/笔记本只读、右侧面板不可用），不可发送/编辑。
 * 故只有 on/off（shared），无分享模式之分。
 */
export interface WebUiBindingApi {
  setShared: (params: { sessionId: string; shared: boolean }) => Promise<{ success: boolean }>
  isShared: (sessionId: string) => Promise<boolean>
  /** 已分享（仅查看）的会话 id 列表 */
  listShared: () => Promise<string[]>
  serverStatus: () => Promise<{ running: boolean; port?: number; urls?: string[] }>
}

/** Telegram Bot：把会话绑定到 Bot 渠道（出站，宿主需能托管 / 连接 Bot） */
export interface TelegramBindingApi {
  listBots: () => Promise<TelegramBotInfo[]>
  addBot: (params: TelegramBotAddParams) => Promise<TelegramBotInfo>
  updateBot: (params: TelegramBotUpdateParams) => Promise<{ success: boolean }>
  deleteBot: (id: string) => Promise<{ success: boolean }>
  validateToken: (token: string) => Promise<{
    valid: boolean
    username?: string
    id?: number
    error?: string
  }>
  bindSession: (params: TelegramBindSessionParams) => Promise<{ success: boolean }>
  unbindSession: (params: TelegramUnbindSessionParams) => Promise<{ success: boolean }>
  getSessionBotId: (sessionId: string) => Promise<string | null>
  startBot: (botId: string) => Promise<{ success: boolean }>
  stopBot: (botId: string) => Promise<{ success: boolean }>
  getBotStatus: (botId: string) => Promise<{ running: boolean }>
}

/** 会话渠道绑定能力轴：每个渠道按宿主能力可选提供（缺省 = 该宿主不支持该渠道） */
export interface ChannelBindingApi {
  webui?: WebUiBindingApi
  telegram?: TelegramBindingApi
}
