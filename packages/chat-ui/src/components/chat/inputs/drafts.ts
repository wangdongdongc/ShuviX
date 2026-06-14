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

// ─── Approval ──────────────────────────────────────────

/**
 * Approval 表单的草稿状态
 *
 * 与 Choice/Ssh 不同,Approval 是"按一个按钮就提交"的语义。stagedResponse
 * 字段表达"用户已点选了某个动作但尚未真正提交"(用于多 tab 场景的批量提交)。
 */
export interface ApprovalDraft {
  /** 用户已点选的动作 — 一旦设置,该 tab 就被视为"已填" */
  stagedResponse?: InputResponse
  /** "允许并记住"模式预览面板:null = 未进入,[] = 进入但被清空,string[] = 待保存的模式 */
  previewPatterns?: string[] | null
}

export function emptyApprovalDraft(): ApprovalDraft {
  return {}
}

export function buildApprovalResponse(draft: ApprovalDraft): InputResponse | null {
  return draft.stagedResponse ?? null
}

// ─── SshCredentials ────────────────────────────────────

export type SshAuthMode = 'password' | 'key'

export interface SshCredentialsDraft {
  authMode: SshAuthMode
  host: string
  port: string
  username: string
  password: string
  privateKey: string
  keyFileName: string
  passphrase: string
}

export function emptySshCredentialsDraft(prefill?: {
  host?: string
  port?: number
  username?: string
}): SshCredentialsDraft {
  return {
    authMode: 'password',
    host: prefill?.host ?? '',
    port: String(prefill?.port ?? 22),
    username: prefill?.username ?? '',
    password: '',
    privateKey: '',
    keyFileName: '',
    passphrase: ''
  }
}

function isSshDraftValid(draft: SshCredentialsDraft): boolean {
  if (!draft.host.trim() || !draft.username.trim()) return false
  if (draft.authMode === 'password') return draft.password.trim().length > 0
  return draft.privateKey.trim().length > 0
}

export function buildSshCredentialsPayload(
  draft: SshCredentialsDraft
): import('@shuvix/chat-protocol/types/inputRequest').SshCredentialPayload {
  const base = {
    host: draft.host.trim(),
    port: parseInt(draft.port, 10) || 22,
    username: draft.username.trim()
  }
  if (draft.authMode === 'password') {
    return { ...base, password: draft.password }
  }
  return {
    ...base,
    privateKey: draft.privateKey,
    ...(draft.passphrase ? { passphrase: draft.passphrase } : {})
  }
}

export function buildSshCredentialsResponse(draft: SshCredentialsDraft): InputResponse | null {
  if (!isSshDraftValid(draft)) return null
  return { kind: 'sshCredentials', credentials: buildSshCredentialsPayload(draft) }
}

export function isSshCredentialsDraftValid(draft: SshCredentialsDraft): boolean {
  return isSshDraftValid(draft)
}
