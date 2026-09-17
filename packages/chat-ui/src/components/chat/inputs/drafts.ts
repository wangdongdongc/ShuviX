/**
 * 各类用户输入子表单的 draft 类型 + 工厂 + 校验/构造 helper
 *
 * 单独成文件,避免和 *.tsx 组件文件混用导致 react-refresh 抱怨
 * "only-export-components"。
 */
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

// ─── Choice ────────────────────────────────────────────

export interface ChoiceDraft {
  selected: string[]
}

export function emptyChoiceDraft(): ChoiceDraft {
  return { selected: [] }
}

export function buildChoiceResponse(draft: ChoiceDraft): InputResponse | null {
  if (!draft.selected || draft.selected.length === 0) return null
  return { kind: 'choice', selections: draft.selected }
}

// ─── Ask ──────────────────────────────────────────

/**
 * Ask 表单的草稿状态
 *
 * 与 Choice 不同,Ask 是"按一个按钮就提交"的语义。stagedResponse
 * 字段表达"用户已点选了某个动作但尚未真正提交"(用于多 tab 场景的批量提交)。
 */
export interface AskDraft {
  /** 用户已点选的动作 — 一旦设置,该 tab 就被视为"已填" */
  stagedResponse?: InputResponse
  /** "允许并记住"模式预览面板:null = 未进入,[] = 进入但被清空,string[] = 待保存的模式 */
  previewPatterns?: string[] | null
}

export function emptyAskDraft(): AskDraft {
  return {}
}

export function buildAskResponse(draft: AskDraft): InputResponse | null {
  return draft.stagedResponse ?? null
}
