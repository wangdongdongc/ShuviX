/**
 * P3-08-58 —— 协作编辑的虚影来源（`ghostSourcesOf`，从 useCoEditing 抽出的纯函数）：
 *  - 实时卡上的 doc_edit 块 + 流式参数原文 → `{toolCallId, toolName, json: argsText}`；
 *  - 没有原文 → 解析出的部分参数序列化；
 *  - 不是 doc_* 的块（read）不算；
 *  - 进度做完（`toolRuns` done）或落盘的工具块已带结果 → 不再是「正在写」；
 *  - 没有实时卡 / 没有视图 → 空。
 *
 * 钩子里的那一半（画 `.cm-coedit-ghost`、落盘 / agent_end / error 时收掉、一帧至多画一次）要 DOM 与编辑器，
 * 渲染层单测只收纯逻辑 —— 它由 e2e markdown-coedit（MC-9/10/15，P3-15b）覆盖。
 */
import { describe, expect, it } from 'vitest'
import { DOC_EDIT_TOOL, DOC_INSERT_TOOL } from '@shuvix/chat-protocol/liveDocument'
import type { AssistantBlock, ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { LiveCard, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { ghostSourcesOf } from '../ghostSources'

function live(blocks: AssistantBlock[], argsText?: Record<string, string>): LiveCard {
  return {
    id: 'live:1',
    message: {
      id: 'live:1',
      sessionId: 's1',
      role: 'assistant',
      type: 'message',
      blocks,
      content: '',
      model: 'm',
      createdAt: 0,
      metadata: null
    },
    ...(argsText === undefined ? {} : { argsText })
  }
}

const view = (
  card: LiveCard | null,
  extra: Partial<Pick<SessionView, 'toolRuns' | 'messages'>> = {}
): Pick<SessionView, 'live' | 'toolRuns' | 'messages'> => ({
  live: card,
  toolRuns: extra.toolRuns ?? {},
  messages: extra.messages ?? []
})

describe('P3-08-58 ghostSourcesOf', () => {
  it('doc_edit 块 + argsText → json 就是原文', () => {
    const json = '{"find":"abc","replace":"xy'
    expect(
      ghostSourcesOf(
        view(
          live([{ type: 'tool', toolCallId: 'A', toolName: DOC_EDIT_TOOL, args: {} }], { A: json })
        )
      )
    ).toEqual([{ toolCallId: 'A', toolName: DOC_EDIT_TOOL, json }])
  })

  it('没有 argsText → 部分参数的序列化；doc_insert 也算；read 不算', () => {
    const args = { anchor: 'x', text: 'y' }
    expect(
      ghostSourcesOf(
        view(
          live([
            { type: 'tool', toolCallId: 'R', toolName: 'read', args: { path: 'a' } },
            { type: 'tool', toolCallId: 'B', toolName: DOC_INSERT_TOOL, args }
          ])
        )
      )
    ).toEqual([{ toolCallId: 'B', toolName: DOC_INSERT_TOOL, json: JSON.stringify(args) }])
  })

  it('进度做完、或落盘的块已带结果 → 排除', () => {
    const card = live([{ type: 'tool', toolCallId: 'A', toolName: DOC_EDIT_TOOL, args: {} }])
    expect(ghostSourcesOf(view(card, { toolRuns: { A: { status: 'done' } } }))).toEqual([])
    const committed: ChatMessage = {
      id: '5',
      sessionId: 's1',
      role: 'assistant',
      type: 'message',
      blocks: [{ type: 'tool', toolCallId: 'A', toolName: DOC_EDIT_TOOL, args: {}, result: 'ok' }],
      content: '',
      model: 'm',
      createdAt: 0,
      metadata: null
    }
    expect(ghostSourcesOf(view(card, { messages: [committed] }))).toEqual([])
    // 还在跑（running）的不排除
    expect(ghostSourcesOf(view(card, { toolRuns: { A: { status: 'running' } } }))).toHaveLength(1)
  })

  it('没有实时卡 / 没有视图 → 空', () => {
    expect(ghostSourcesOf(view(null))).toEqual([])
    expect(ghostSourcesOf(undefined)).toEqual([])
  })
})
