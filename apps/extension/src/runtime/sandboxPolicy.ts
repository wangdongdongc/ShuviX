/**
 * 扩展 SandboxPolicy —— 接入共享 assertSandbox 的统一审批路径。
 *
 * 决策(用户已定):扩展根句柄(FSA 项目文件夹 / OPFS 临时目录)都是硬边界,且:
 *   - 项目:用户选文件夹时已授权整夹读写;
 *   - 临时:OPFS 不涉及用户真实文件。
 * 故"夹内读写一律放行不弹"——和桌面工作目录内行为完全一致。
 *
 * 审批代码路径照样接上(requestUserInput 注入),当前 isAllowedWithoutPrompt 恒 true 故不触发;
 * 将来若加"越界/第二目录"能力,直接复用已共享的扩展审批 UI(ApprovalForm)。
 */
import type { SandboxPolicy } from '@shuvix/agent-runtime'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

export function createExtensionSandboxPolicy(
  requestUserInput?: (req: InputRequest) => Promise<InputResponse>
): SandboxPolicy {
  return {
    isAllowedWithoutPrompt: () => true, // 根内一律放行
    isAutoApprove: () => true,
    isInAllowList: () => false,
    buildApprovalCommand: (mode, p) => `${mode === 'read' ? 'Read' : 'Write'}(${p})`,
    isDirectory: () => false,
    persistAllow: () => {},
    requestUserInput
  }
}
