/**
 * 触发器替 bot 发的消息（来源 `trigger`）里系统写的那一段：事件围栏 + 一句固定说明。形状照运行中插话的说明
 * （midRunNote.ts）：模型文本 = 绑定里的 message + 这一段；显示侧车 = message + 一枚内联 Token（uid → Token），气泡上
 * 是一枚小胶囊，悬停 / 点开看 payload。`displayText` 刻意是空串：复制、纯文本、回填输入框都只留 message。
 *
 * 说明跟着这一条消息走，不写进 bot 的系统提示词：用户之后在这条会话里接着说话，那些消息不带它，模型分得清谁在场；
 * 用户覆盖 `bot` 档案也丢不了。
 *
 * 只由宿主在触发时构造（`botTriggerService`），前端从不构造它。本模块纯数据、不依赖 Node / Electron。
 */
import { isMidRunNoteToken } from './midRunNote'
import { isSessionSenderToken } from './sessionSender'
import type { InlineToken } from './types/chatMessage'
import { makeTokenMarker, TOKEN_RE } from './utils/inlineTokens'

/** Token 的 `type`；`id` 是触发点 id（如 `timer.fired`），`name` 是胶囊上的触发时间 */
export const TRIGGER_EVENT_TOKEN_TYPE = 'trigger'

/** 显示侧车里这枚 Token 的 uid（一条消息只有一枚） */
export const TRIGGER_EVENT_UID = 'trigger'

/**
 * 模型面向的说明（英文）：只写模型自己不知道的事实，不下命令 —— 该不该问、怎么留话由 agent 判断。
 * 「后面的触发被跳过」是 botTriggerService 的 inFlight：一次运行 = 这一轮，停在询问上同样算在跑。
 */
export const TRIGGER_EVENT_NOTE_TEXT =
  "[Sent automatically: a trigger in your bot file fired and ShuviX sent this for it. The user did not type it just now and may not be watching; they can read this session later and reply here. If you stop to wait for an answer, this run stays open and the trigger's next firings are skipped until it ends.]"

/** 模型文本里 message、事件围栏、说明之间的分隔 */
const SEPARATOR = '\n\n'

/** 一条触发消息：模型收到的全文 + 显示侧车 */
export interface TriggerEventMessage {
  text: string
  display: { content: string; tokens: Record<string, InlineToken> }
}

/**
 * `message` 与 `fence` 要是已经过脱敏的那份（调用方先换再拼）：显示侧车与模型文本同一份占位符，模型收到什么、界面显示
 * 什么都由安全策略判定（redact-sensitive），这里不做任何判断。说明是系统写的，不算输入，不用换。
 *
 * payload 带开头的分隔：重新生成经 `resolveTokensForAgent` 把标记换回 payload，要与第一次发的全文逐字相同。
 */
export function triggerEventMessage(input: {
  message: string
  fence: string
  /** 触发点 id（如 `timer.fired`） */
  trigger: string
  /** 胶囊上的触发时间（如 `11-02 18:00`） */
  firedLabel: string
}): TriggerEventMessage {
  const payload = `${SEPARATOR}${input.fence}${SEPARATOR}${TRIGGER_EVENT_NOTE_TEXT}`
  return {
    text: `${input.message}${payload}`,
    display: {
      content: `${input.message}${makeTokenMarker(TRIGGER_EVENT_UID)}`,
      tokens: {
        [TRIGGER_EVENT_UID]: {
          type: TRIGGER_EVENT_TOKEN_TYPE,
          id: input.trigger,
          displayText: '',
          payload,
          name: input.firedLabel
        }
      }
    }
  }
}

/** 是不是触发事件 Token（只看 type） */
export function isTriggerEventToken(token: unknown): boolean {
  if (typeof token !== 'object' || token === null) return false
  return (token as { type?: unknown }).type === TRIGGER_EVENT_TOKEN_TYPE
}

/** 系统写的 Token：运行中插话的说明、触发事件、别的会话发来的消息的发送方 */
function isSystemToken(token: unknown): boolean {
  return isMidRunNoteToken(token) || isTriggerEventToken(token) || isSessionSenderToken(token)
}

/**
 * 把带标记的显示文本里系统写的标记去掉（读「这条消息说了什么」的地方用：大纲、转写摘要、导出）。重新生成不用它：
 * 重发一条触发消息时事件还是它的一部分，别的会话发来的那条同样（插话说明才不跟着重发，见 midRunNote.ts）。
 */
export function withoutSystemTokens(
  content: string,
  tokens: Record<string, unknown> | undefined
): string {
  if (tokens === undefined || !Object.values(tokens).some(isSystemToken)) return content
  return content.replace(new RegExp(TOKEN_RE.source, 'g'), (marker, uid: string) =>
    isSystemToken(tokens[uid]) ? '' : marker
  )
}

/** 去掉系统写的 Token；去完一枚不剩 → undefined */
export function tokensWithoutSystemTokens<T>(
  tokens: Record<string, T> | undefined
): Record<string, T> | undefined {
  if (tokens === undefined || !Object.values(tokens).some(isSystemToken)) return tokens
  const kept = Object.entries(tokens).filter(([, token]) => !isSystemToken(token))
  return kept.length === 0 ? undefined : Object.fromEntries(kept)
}
