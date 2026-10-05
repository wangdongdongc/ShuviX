/**
 * P2-07 的调用身份素材（Fx-ID / 三份 `_meta` / 期望的安全主体），四台内置服务器的测试共用。
 *
 * 一份内置实例由根 agent 与它派出的 agent 共用：客户端经 `_meta` 带来 `shuvix.dev/conversationId`，
 * 服务器把它并进 EnforceOpts、把 scope 的 `agentOf` 交给 getDesktopSecurityContext，主体按调用现认。
 * 这里的三个身份与 P2-06 的同名素材一致：对话 1 = 锁住的根（work），2 = 派生的 explore，
 * 3 = hook 派出的权限审查员；别的对话认不出（undefined）。
 */
import { vi, type Mock } from 'vitest'
import type { ToolAgentIdentity } from '../../toolAgent'

export const WORK: ToolAgentIdentity = { profileName: 'work', kind: 'root' }
export const SPAWN_E: ToolAgentIdentity = {
  profileName: 'explore',
  kind: 'spawned',
  callerId: 'sub-a1'
}
export const HOOK_R: ToolAgentIdentity = {
  profileName: 'permission-reviewer',
  kind: 'spawned',
  callerId: 'sub-r1'
}

export type AgentOfMock = Mock<(conversationId: number) => ToolAgentIdentity | undefined>

/** 对话 → 身份（1 / 2 / 3 认得出，其余 undefined）；每个用例新建一份，断言调用次数用 */
export function makeAgentOf(): AgentOfMock {
  const table: Record<number, ToolAgentIdentity> = { 1: WORK, 2: SPAWN_E, 3: HOOK_R }
  return vi.fn((conversationId: number) => table[conversationId])
}

/** 一份可信 server 收到的 `_meta`（键都带 `shuvix.dev/` 前缀） */
export function metaOf(
  toolCallId: string,
  agentId: string | undefined,
  taskId: unknown,
  conversationId: unknown
): Record<string, unknown> {
  return {
    'shuvix.dev/toolCallId': toolCallId,
    ...(agentId !== undefined ? { 'shuvix.dev/agentId': agentId } : {}),
    ...(taskId !== undefined ? { 'shuvix.dev/taskId': taskId } : {}),
    ...(conversationId !== undefined ? { 'shuvix.dev/conversationId': conversationId } : {})
  }
}

/** 根 agent 的一次调用 */
export const M1 = metaOf('tc-1', 's1', 20, 1)
/** 派生 explore 的一次调用 */
export const M2 = metaOf('tc-2', 'sub-a1', 21, 2)
/** 权限审查员的一次调用 */
export const M3 = metaOf('tc-3', 'sub-r1', 22, 3)

/** 认不出调用方时的主体：root、没有 profileName 这个键（今天的口径） */
export const SUBJ_ROOT0 = (sessionId = 's1'): Record<string, unknown> => ({
  kind: 'agent',
  sessionId,
  agentKind: 'root'
})
export const SUBJ_WORK = (sessionId = 's1'): Record<string, unknown> => ({
  kind: 'agent',
  sessionId,
  agentKind: 'root',
  profileName: 'work'
})
export const SUBJ_E = (sessionId = 's1'): Record<string, unknown> => ({
  kind: 'agent',
  sessionId,
  agentKind: 'spawned',
  profileName: 'explore'
})
export const SUBJ_R = (sessionId = 's1'): Record<string, unknown> => ({
  kind: 'agent',
  sessionId,
  agentKind: 'spawned',
  profileName: 'permission-reviewer'
})

/** 询问事件里的主体（Fx-MOCK 的 onPermissionRequest 记下的事件） */
export const subjectOf = (event: unknown): unknown =>
  (event as { request: { subject: unknown } }).request.subject
