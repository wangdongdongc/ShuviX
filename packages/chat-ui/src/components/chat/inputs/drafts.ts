/**
 * 各类用户输入子表单的 draft 类型 + 工厂 + 校验/构造 helper
 *
 * 单独成文件,避免和 *.tsx 组件文件混用导致 react-refresh 抱怨
 * "only-export-components"。
 */
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

// ─── 「其它」 ───────────────────────────────────────────

/**
 * 卡片最后一行写的话投成「其它」；空白不算。`secrets: []` 让宿主走输入框那条路（见 OtherAnswerRow）。
 */
export function otherResponseOf(text: string | undefined): InputResponse | null {
  const trimmed = text?.trim()
  return trimmed ? { kind: 'other', text: trimmed, secrets: [] } : null
}

// ─── Choice ────────────────────────────────────────────

export interface ChoiceDraft {
  selected: string[]
  /** 卡片最后一行写的话 */
  otherText?: string
}

export function emptyChoiceDraft(): ChoiceDraft {
  return { selected: [] }
}

/** 勾选和写的话一起发：只勾 = 选项，只写 = 「其它」，都有 = 选项带一句话，都没有 = 还不能发 */
export function buildChoiceResponse(draft: ChoiceDraft): InputResponse | null {
  if (!draft.selected || draft.selected.length === 0) return otherResponseOf(draft.otherText)
  const note = draft.otherText?.trim()
  return note
    ? { kind: 'choice', selections: draft.selected, note, secrets: [] }
    : { kind: 'choice', selections: draft.selected }
}

// ─── Ask ──────────────────────────────────────────

/**
 * Ask 表单的草稿状态
 *
 * 与 Choice 不同,Ask 的选项行点一下就提交,所以只有写的话才算"已填"。
 */
export interface AskDraft {
  /** "允许并记住"模式预览面板:null = 未进入,[] = 进入但被清空,string[] = 待保存的模式 */
  previewPatterns?: string[] | null
  /** 卡片最后一行写的话 */
  otherText?: string
}

export function emptyAskDraft(): AskDraft {
  return {}
}

export function buildAskResponse(draft: AskDraft): InputResponse | null {
  return otherResponseOf(draft.otherText)
}
