/** 转写与请求的紧凑渲染：`<kind>:<text>`（跳过 pi.system） */
import type { Message } from '@earendil-works/pi-ai'
import type { Conversation, EntryRecord } from '@earendil-works/pi-durable'
import { backgroundContext as BG } from '../../context'
import type { FauxKit } from './faux'

/** 一条消息的文本：user / toolResult 的文本块，assistant 的文本（没有文本时是 `[tool:name]`） */
export function messageText(message: Message | undefined): string {
  if (message === undefined) return ''
  switch (message.role) {
    case 'system':
      return ''
    case 'user':
      return typeof message.content === 'string'
        ? message.content
        : message.content
            .map((part) => (part.type === 'text' ? part.text : `[image:${part.mimeType}]`))
            .join('')
    case 'assistant': {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
      if (text.length > 0) return text
      return message.content
        .filter((part) => part.type === 'toolCall')
        .map((part) => (part.type === 'toolCall' ? `[tool:${part.name}]` : ''))
        .join('')
    }
    case 'toolResult':
      return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  }
}

/** 一个对话的全部条目（fork 感知），最旧在前 */
export async function allEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({}, 1000, undefined, BG)
  return [...page.items].reverse()
}

/** `<kind>:<text>`，跳过 pi.system */
export async function transcript(conversation: Conversation): Promise<string[]> {
  return (await allEntries(conversation))
    .filter((entry) => entry.kind !== 'pi.system')
    .map((entry) => `${entry.kind}:${messageText(entry.model?.[0])}`)
}

/** 第 n 个请求里的消息：`<role>:<text>`（跳过 system） */
export function requestTexts(kit: FauxKit, n: number): string[] {
  const request = kit.requests[n]
  if (request === undefined) throw new Error(`request ${n} was not made (${kit.requests.length})`)
  return request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role}:${messageText(message)}`)
}

/** 一条 pi.system 条目带来的变化：段落 key（含删除）、加 / 减的工具名 */
export interface SystemDelta {
  readonly sections: string[]
  readonly toolsAdded: string[]
  readonly toolsRemoved: string[]
}

/** 一个对话里每条 pi.system 条目的变化，最旧在前 */
export async function systemDeltas(conversation: Conversation): Promise<SystemDelta[]> {
  return (await allEntries(conversation))
    .filter((entry) => entry.kind === 'pi.system')
    .map((entry) => {
      const message = entry.model?.[0]
      if (message?.role !== 'system') return { sections: [], toolsAdded: [], toolsRemoved: [] }
      return {
        sections: Object.keys(message.sections ?? {}),
        toolsAdded: (message.toolsAdded ?? []).map((tool) => tool.name),
        toolsRemoved: (message.toolsRemoved ?? []).map((tool) => tool.name)
      }
    })
}

/** 带工具增减的 pi.system 条目数（从第 `from` 条 pi.system 起） */
export async function toolDeltaCount(conversation: Conversation, from = 0): Promise<number> {
  return (await systemDeltas(conversation))
    .slice(from)
    .filter((delta) => delta.toolsAdded.length > 0 || delta.toolsRemoved.length > 0).length
}
