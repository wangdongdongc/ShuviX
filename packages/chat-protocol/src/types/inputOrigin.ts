/**
 * 一条用户输入是从哪来的（2026-10-21 用户裁决：每一条都记）—— 宿主在受理时按**连接**盖章，从不取请求里自带的：
 * 渲染端、网络客户端都碰不到这一项。界面按它给不同来源不同的样式（`UserTextMeta.origin`），自动审查、大纲按它
 * 分「人打的」与「别的会话发的」。
 *
 *   local     桌面应用里的窗口（主窗口、笔记本窗口……）
 *   remote    远程访问进来的浏览器 / 手机：哪条连接、对端地址、浏览器标识（User-Agent）
 *   chrome    Chrome 扩展的侧边栏：哪个浏览器（扩展安装 id）
 *   telegram  Telegram bot 收到的消息：哪个 bot、哪个 Telegram 用户、哪个对话
 *   parent-session / session  别的会话发进来的（子会话的父会话 / 经会话权限表被授权的会话，见 DrivingSessionRef）
 *   trigger   触发器发的：触发源（如内置 timer）的一次事件命中了某个 bot 的绑定，宿主新建会话并替它发出绑定里的话
 *
 * 人的四种来源可以多带一项 `suggestion`：这句话是用户**采纳了 agent 的一条提议**（`suggest` 工具）发出的 —— 人点的，
 * 文字却是 agent 写的。同样由宿主盖章（`suggestion:accept`），自动审查据此在这句话前注明出处（2026-10-25）。
 *
 * 落在会话存储的 `SourceDoc` 里（按这次提交的 requestId；会话导出默认不带，fork 照样带 —— 那是同一段对话的副本）。
 * 认不出的形状：界面上当作没有来源；审查、大纲当作「不是人打的」（失败闭合，见 agent-runtime `inputSource.ts`）。
 */
import type { DrivingSessionRef } from './inputRequest'

/**
 * 采纳的是哪一条提议：那次 `suggest` 调用所在的助手消息（条目 id）、调用的 toolCallId、第几条（从 0 起）。
 * 带上消息 id 是因为 provider 的 toolCallId 在一条会话里可能重复（有的每次回复都从 `call_0` 数起）
 */
export interface SuggestionRef {
  messageId: string
  toolCallId: string
  index: number
}

export interface LocalOrigin {
  kind: 'local'
  suggestion?: SuggestionRef
}

export interface RemoteOrigin {
  kind: 'remote'
  /** 远程访问的那条连接（network 前端的客户端 id） */
  clientId: string
  /** 对端地址（连接上取的，不信请求头里的 X-Forwarded-For 之类；取不到是空串） */
  address: string
  /** 浏览器标识（WebSocket 升级请求的 User-Agent；没有就缺省） */
  userAgent?: string
  suggestion?: SuggestionRef
}

export interface ChromeOrigin {
  kind: 'chrome'
  /** 扩展的安装 id（哪个 Chrome；扩展没报就缺省） */
  installId?: string
  suggestion?: SuggestionRef
}

export interface TelegramOrigin {
  kind: 'telegram'
  botId: string
  userId: string
  chatId: string
  suggestion?: SuggestionRef
}

/**
 * 触发器发的：一次触发事件命中了某个 bot 的绑定（bot md 的 `shuvix-bot-on`），宿主替它发出绑定里写的话。话是事先
 * 写在 bot 文件里的，不是此刻有人在场 —— 审查、大纲把它算作「不是人打的」。
 */
export interface TriggerOrigin {
  kind: 'trigger'
  /** 触发点 id（如 `timer.fired`） */
  trigger: string
  /** 发出事件的那个触发源实例（如内置 timer `timer:builtin:minute`）；事件没带就缺省 */
  sourceId?: string
  /** 绑定所在的 bot（名字，即会话的 `settings.bot`） */
  bot: string
}

/** 人在某个前端里打的 */
export type HumanOrigin = LocalOrigin | RemoteOrigin | ChromeOrigin | TelegramOrigin

/** 不是人打的：别的会话发进来的，或触发器发的 */
export type MachineOrigin = DrivingSessionRef | TriggerOrigin

export type InputOrigin = HumanOrigin | MachineOrigin

/** 别的会话发进来的（不是人打的） */
export function isDrivingOrigin(origin: InputOrigin): origin is DrivingSessionRef {
  return origin.kind === 'parent-session' || origin.kind === 'session'
}

/** 不是人打的：别的会话发进来的，或触发器发的 */
export function isMachineOrigin(origin: InputOrigin): origin is MachineOrigin {
  return isDrivingOrigin(origin) || origin.kind === 'trigger'
}

function str(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** 存储里的 `suggestion` → 提议引用；缺字段、类型不对 → undefined（这句话照样是人的，只是不算采纳的提议） */
export function suggestionRefOf(value: unknown): SuggestionRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  if (!str(o.messageId) || !str(o.toolCallId)) return undefined
  if (!Number.isSafeInteger(o.index) || (o.index as number) < 0) return undefined
  return { messageId: o.messageId, toolCallId: o.toolCallId, index: o.index as number }
}

/** 人的来源带上它的提议引用（有的话） */
function withSuggestion<T extends HumanOrigin>(origin: T, raw: unknown): T {
  const suggestion = suggestionRefOf(raw)
  return suggestion === undefined ? origin : { ...origin, suggestion }
}

/**
 * 存储里的一项 → 来源（形状判别，只取认得的字段、拷出新对象）；认不出的种类、缺字段、字段类型不对 → undefined。
 * 2026-10-21 之前写的项只有 `parent-session` / `session` 两种，形状不变；`trigger` 自 2026-10-24 起。
 */
export function inputOriginOf(item: unknown): InputOrigin | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const o = item as Record<string, unknown>
  switch (o.kind) {
    case 'local':
      return withSuggestion({ kind: 'local' }, o.suggestion)
    case 'remote':
      if (!str(o.clientId) || typeof o.address !== 'string') return undefined
      return withSuggestion(
        str(o.userAgent)
          ? { kind: 'remote', clientId: o.clientId, address: o.address, userAgent: o.userAgent }
          : { kind: 'remote', clientId: o.clientId, address: o.address },
        o.suggestion
      )
    case 'chrome':
      return withSuggestion(
        str(o.installId) ? { kind: 'chrome', installId: o.installId } : { kind: 'chrome' },
        o.suggestion
      )
    case 'telegram':
      if (!str(o.botId) || !str(o.userId) || !str(o.chatId)) return undefined
      return withSuggestion(
        { kind: 'telegram', botId: o.botId, userId: o.userId, chatId: o.chatId },
        o.suggestion
      )
    case 'trigger':
      if (!str(o.trigger) || !str(o.bot)) return undefined
      return str(o.sourceId)
        ? { kind: 'trigger', trigger: o.trigger, sourceId: o.sourceId, bot: o.bot }
        : { kind: 'trigger', trigger: o.trigger, bot: o.bot }
    case 'parent-session':
    case 'session':
      if (!str(o.sessionId)) return undefined
      return typeof o.title === 'string'
        ? { kind: o.kind, sessionId: o.sessionId, title: o.title }
        : { kind: o.kind, sessionId: o.sessionId }
    default:
      return undefined
  }
}
