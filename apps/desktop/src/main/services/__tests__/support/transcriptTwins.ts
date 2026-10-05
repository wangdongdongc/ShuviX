/**
 * 转写摘要（P2-14）的桌面用例共用：一份脚本建成两份会话 —— 孪生规则（设计 §B）。
 *
 *  - **(L)** 旧格式：脚本 → v3 JSONL 文本 → 真 `harnessV3TextToChatMessages`（冻结投影），由
 *    `messageService.listBySession` 的替身交出；
 *  - **(D)** durable：同一份脚本的条目写进一个 MemoryStorage 会话（真 `createSessionHost`），由
 *    `getSessionHost().peek` 的替身交出。
 *
 * 两边用同一组毫秒时间戳（v3 条目的 ISO 时间 = durable 消息的 timestamp），所以两边的 payload / 事实
 * 应当逐字相等。另有一个按 types.ts 构造 ask 事件的 `makeEvent` 与 MemoryStorage 宿主。
 */
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai'
import {
  MemoryStorage,
  type ConversationId,
  type EntryDraft,
  type EntryRecord,
  type JsonObject
} from '@earendil-works/pi-durable'
import {
  backgroundContext as BG,
  DisplayDoc,
  noticeEntryDraft,
  type DurableSession,
  type PermissionRequestEvent,
  type SecurityRequest,
  type SessionHost
} from '@shuvix/agent-runtime'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { wrapSummary } from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/digest'
import { makeRealHost } from './realHost'

export {
  bg,
  call,
  IMAGE,
  text,
  thinking
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/digest'

export interface DisplaySidecar {
  content: string
  tokens: Record<string, InlineToken>
}

export type TwinStep =
  | {
      type: 'user'
      ts: number
      content: string | (TextContent | ImageContent)[]
      display?: DisplaySidecar
    }
  | {
      type: 'assistant'
      ts: number
      content: string | (TextContent | ThinkingContent | ToolCall)[]
      stopReason?: 'stop' | 'toolUse' | 'error' | 'aborted' | 'length'
      errorMessage?: string
    }
  | {
      type: 'result'
      ts: number
      callId: string
      toolName?: string
      content: string | (TextContent | ImageContent)[]
      isError?: boolean
    }
  | { type: 'notice'; ts: number; text: string }
  /** `keptFrom` = 第一条保留的那一步在脚本里的下标 */
  | { type: 'compaction'; ts: number; summary: string; keptFrom: number }

export const user = (
  ts: number,
  content: string | (TextContent | ImageContent)[],
  display?: DisplaySidecar
): TwinStep => ({ type: 'user', ts, content, ...(display ? { display } : {}) })

export const assistant = (
  ts: number,
  content: string | (TextContent | ThinkingContent | ToolCall)[],
  options: {
    stopReason?: 'stop' | 'toolUse' | 'error' | 'aborted' | 'length'
    errorMessage?: string
  } = {}
): TwinStep => ({ type: 'assistant', ts, content, ...options })

export const result = (
  ts: number,
  callId: string,
  content: string | (TextContent | ImageContent)[],
  options: { toolName?: string; isError?: boolean } = {}
): TwinStep => ({ type: 'result', ts, callId, content, ...options })

export const notice = (ts: number, text: string): TwinStep => ({ type: 'notice', ts, text })

export const compaction = (ts: number, summary: string, keptFrom: number): TwinStep => ({
  type: 'compaction',
  ts,
  summary,
  keptFrom
})

const iso = (ts: number): string => new Date(ts).toISOString()

function toolResultContent(
  content: string | (TextContent | ImageContent)[]
): (TextContent | ImageContent)[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

// ─── (L) v3 JSONL ───────────────────────────────────────

/** 脚本 → 一份 v3 `.jsonl` 文本（线性分支；显示侧车 / 通知侧车紧挨在它的 user 之前） */
export function legacyJsonl(sessionId: string, steps: readonly TwinStep[]): string {
  const lines: string[] = [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: iso(0), cwd: '/twin' })
  ]
  let seq = 0
  let parentId: string | null = null
  /** 每一步的第一条条目 id（压缩的 firstKeptEntryId 指向它） */
  const firstIds: string[] = []
  const push = (entry: Record<string, unknown>, ts: number): string => {
    const id = `e${++seq}`
    lines.push(JSON.stringify({ ...entry, id, parentId, timestamp: iso(ts) }))
    parentId = id
    return id
  }
  for (const step of steps) {
    switch (step.type) {
      case 'user': {
        const first = step.display
          ? push(
              { type: 'custom', customType: 'shuvix:inline_tokens', data: step.display },
              step.ts
            )
          : undefined
        const id = push(
          { type: 'message', message: { role: 'user', content: step.content, timestamp: step.ts } },
          step.ts
        )
        firstIds.push(first ?? id)
        break
      }
      case 'assistant':
        firstIds.push(
          push(
            {
              type: 'message',
              message: fauxAssistantMessage(step.content, {
                timestamp: step.ts,
                ...(step.stopReason ? { stopReason: step.stopReason } : {}),
                ...(step.errorMessage !== undefined ? { errorMessage: step.errorMessage } : {})
              })
            },
            step.ts
          )
        )
        break
      case 'result':
        firstIds.push(
          push(
            {
              type: 'message',
              message: {
                role: 'toolResult',
                toolCallId: step.callId,
                toolName: step.toolName ?? 'ask',
                content: toolResultContent(step.content),
                isError: step.isError ?? false,
                timestamp: step.ts
              }
            },
            step.ts
          )
        )
        break
      case 'notice': {
        const first = push(
          { type: 'custom', customType: 'shuvix:system_notice', data: {} },
          step.ts
        )
        push(
          {
            type: 'message',
            message: {
              role: 'user',
              content: [{ type: 'text', text: step.text }],
              timestamp: step.ts
            }
          },
          step.ts
        )
        firstIds.push(first)
        break
      }
      case 'compaction':
        firstIds.push(
          push(
            {
              type: 'compaction',
              summary: step.summary,
              firstKeptEntryId: firstIds[step.keptFrom],
              tokensBefore: 0
            },
            step.ts
          )
        )
        break
    }
  }
  return `${lines.join('\n')}\n`
}

// ─── (D) durable ────────────────────────────────────────

/** 把脚本的条目写进一条打开着的 durable 会话的当前对话（显示侧车 = DisplayDoc + 放下的 submission） */
export async function writeDurable(
  session: DurableSession,
  steps: readonly TwinStep[]
): Promise<void> {
  const conversation = await session.currentConversation()
  const id = conversation.id as ConversationId
  const records: EntryRecord[] = []
  let seq = 0
  for (const step of steps) {
    let draft: EntryDraft
    switch (step.type) {
      case 'user':
        draft = {
          kind: 'pi.user',
          model: [{ role: 'user', content: step.content, timestamp: step.ts }]
        }
        break
      case 'assistant':
        draft = {
          kind: 'pi.assistant',
          model: [
            fauxAssistantMessage(step.content, {
              timestamp: step.ts,
              ...(step.stopReason ? { stopReason: step.stopReason } : {}),
              ...(step.errorMessage !== undefined ? { errorMessage: step.errorMessage } : {})
            })
          ]
        }
        break
      case 'result':
        draft = {
          kind: 'pi.tool-result',
          model: [
            {
              role: 'toolResult',
              toolCallId: step.callId,
              toolName: step.toolName ?? 'ask',
              content: toolResultContent(step.content),
              isError: step.isError ?? false,
              timestamp: step.ts
            }
          ],
          data: { diagnostics: [] }
        }
        break
      case 'notice':
        draft = noticeEntryDraft({ text: step.text, kind: 'background' }, step.ts)
        break
      case 'compaction':
        draft = {
          kind: 'pi.compaction',
          head: records[step.keptFrom]!.id,
          model: [
            {
              role: 'user',
              content: [{ type: 'text', text: wrapSummary(step.summary) }],
              timestamp: step.ts
            }
          ],
          data: { reason: 'threshold' }
        }
        break
    }
    const display = step.type === 'user' ? step.display : undefined
    const requestId = `twin-${++seq}`
    if (display) {
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(DisplayDoc, id)
        doc.items[requestId] = display as unknown as JsonObject
      }, BG)
    }
    const record = await session.harness.commit(async (tx) => {
      const entry = await tx.appendEntry(id, draft)
      if (display) {
        await tx.createSubmission({
          conversationId: id,
          requestId,
          type: 'input',
          status: 'placed',
          entry: entry.id
        })
      }
      return entry
    }, BG)
    records.push(record)
  }
}

// ─── 宿主与事件 ─────────────────────────────────────────

/** 真 SessionHost，存储是按会话的 MemoryStorage（`peek` 只认已经 open 过的会话） */
export function memoryHost(): { host: SessionHost; storages: Map<string, MemoryStorage> } {
  const storages = new Map<string, MemoryStorage>()
  const { host } = makeRealHost({
    storage: {
      openStorage: async (sessionId) => {
        let storage = storages.get(sessionId)
        if (!storage) {
          storage = new MemoryStorage()
          storages.set(sessionId, storage)
        }
        return storage
      },
      storageExists: (sessionId) => storages.has(sessionId),
      deleteStorage: async (sessionId) => {
        storages.delete(sessionId)
      }
    },
    isEphemeral: () => true
  })
  return { host, storages }
}

export const WORKSPACE = '/Users/u/twin'

/** 一次 ask 交给审查接缝的材料：缺省根 agent `work` 要跑一条没圈进沙箱的 `rm -rf build` */
export function makeEvent(
  sessionId: string,
  subject: Partial<SecurityRequest['subject']> = {},
  extra: Partial<PermissionRequestEvent> = {}
): PermissionRequestEvent {
  const request: SecurityRequest = {
    subject: { kind: 'agent', sessionId, profileName: 'work', agentKind: 'root', ...subject },
    action: 'execute',
    object: {
      type: 'command',
      command: 'rm -rf build',
      channel: 'bash',
      sandboxed: false,
      unconfinedReason: 'disabled'
    },
    environment: { host: 'desktop', platform: 'darwin', workspaceDir: WORKSPACE },
    tool: { name: 'bash' }
  }
  return {
    request,
    decision: {
      effect: 'ask',
      tier: 'ask',
      matched: ['ask-on-command#0'],
      winning: 'ask-on-command#0',
      prompt: {
        text: 'This command runs outside the sandbox.',
        rules: ['ask-on-command#0'],
        policies: ['Ask before commands']
      },
      ask: { command: 'rm -rf build' }
    },
    toolCallId: 'tc-twin',
    command: 'rm -rf build',
    ...extra
  }
}

/** 人写输入在 payload 里的两种引述格式 */
export const ans = (question: string, answer: string): string =>
  `(answering the agent's question "${question}") ${answer}`
export const fb = (target: string, textValue: string): string =>
  `(feedback on the approval card for "${target}") ${textValue}`
