/**
 * 共享沙箱/审批后端核心（宿主无关）。
 *
 * 把桌面 toolContext 的 assertSandboxRead/Write + requestPathApproval 逻辑下沉:
 * 放行短路(in-root / autoApprove / allowList) + 越界时经注入的 requestUserInput 走统一审批
 * (复用 chat-protocol 的 ApprovalInputRequest/ApprovalResponse + chat-ui 的 ApprovalForm)。
 *
 * 平台差异全部经 SandboxPolicy 注入:
 *   - 桌面:in-root=workspace/referenceDirs/tool_results/skills;allowList/autoApprove 读 SQLite;
 *           persistAllow 写 SQLite;isDirectory 用 statSync。
 *   - 扩展:根句柄(FSA/OPFS)是硬边界 → isAllowedWithoutPrompt 恒 true(夹内不弹,和桌面工作目录一致)。
 */
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

export type SandboxMode = 'read' | 'write'

export interface SandboxPolicy {
  /** 该路径在 in-root / 参考目录 / 白名单目录内 → 无需审批直接放行 */
  isAllowedWithoutPrompt(mode: SandboxMode, resolvedPath: string): boolean
  /** 会话级自动批准 */
  isAutoApprove(): boolean
  /** allowList 命中(read 接受 read/write 条目,write 仅 write 条目) */
  isInAllowList(mode: SandboxMode, resolvedPath: string): boolean
  /** 审批面板展示文本 / "允许并记住"写入 allowList 的字面值 */
  buildApprovalCommand(mode: SandboxMode, resolvedPath: string): string
  /** 是否目录(read 审批的 UX 区分;可异步) */
  isDirectory(resolvedPath: string): boolean | Promise<boolean>
  /** 审批通过且勾选"记住"时持久化 allow 条目 */
  persistAllow(mode: SandboxMode, resolvedPath: string): void
  /** 已共享的挂起/恢复原语(RuntimeSession.requestUserInput);无前端则越界直接拒绝 */
  requestUserInput?: (req: InputRequest) => Promise<InputResponse>
}

export interface AssertSandboxOpts {
  toolCallId: string
  toolName: string
  /** 报错/展示用路径(相对/展示路径) */
  displayPath?: string
  /** 审批描述(如"批准将授予写权限") */
  description?: string
  /** 取消时抛出的错误文案(桌面 'Aborted' / 扩展 'TOOL_ABORTED') */
  abortError?: string
}

/**
 * 沙箱守卫:放行短路 → 否则经统一审批挂起。
 * - 不通过 → throw(AI 收到 tool error 自行决定)
 * - 通过 → return
 * - 通过 + extra.rememberPattern → policy.persistAllow
 */
export async function assertSandbox(
  policy: SandboxPolicy,
  mode: SandboxMode,
  resolvedPath: string,
  opts: AssertSandboxOpts
): Promise<void> {
  if (policy.isAllowedWithoutPrompt(mode, resolvedPath)) return
  if (policy.isAutoApprove()) return
  if (policy.isInAllowList(mode, resolvedPath)) return

  const display = opts.displayPath ?? resolvedPath
  if (!policy.requestUserInput) {
    throw new Error(`Sandbox: access denied to path outside workspace: ${display}`)
  }

  // 仅 read 关心目录(write 通常指向具体文件)
  const pathIsDirectory = mode === 'read' ? await policy.isDirectory(resolvedPath) : false
  const command = policy.buildApprovalCommand(mode, resolvedPath)

  const response = await policy.requestUserInput({
    id: opts.toolCallId,
    kind: 'approval',
    toolName: opts.toolName,
    command,
    description: opts.description,
    pathIsDirectory,
    createdAt: Date.now()
  })

  if (response.kind === 'cancel') {
    throw new Error(opts.abortError ?? 'Aborted')
  }
  if (response.kind === 'other') {
    throw new Error(
      `User declined access to ${display} and provided feedback instead: ${response.text}`
    )
  }
  if (response.kind !== 'approval' || !response.approved) {
    throw new Error(
      (response.kind === 'approval' && response.reason) || `User denied access to ${display}`
    )
  }
  if (response.extra?.rememberPattern) {
    policy.persistAllow(mode, resolvedPath)
  }
}
