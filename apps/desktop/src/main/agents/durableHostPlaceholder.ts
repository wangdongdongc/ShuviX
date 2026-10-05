/**
 * TODO(pi-durable p1): replaced by agentHost (P1-11)
 *
 * SessionHost 的工具 / 提示词 seam 的占位实现。P1-11 正在改写 `agents/agentHost.ts`，它会导出同名、
 * 同签名的三样东西；两个任务合并时协调方把 `services/sessionHost.ts` 的 import 切过去并删掉本文件。
 *
 * 占位的行为：没有内置工具、没有按 agent 的工具（agent 照样能建、能对话，只是手里什么都没有），
 * 命令沙箱钉子恒为 false；提示词活段落一个都不实现（只有冻结的人设段落），人设变量表为空。
 */
import type {
  LockRecord,
  PromptHost,
  PromptVars,
  PromptVarsCtx,
  ToolHost
} from '@shuvix/agent-runtime'

/** 桌面 ToolHost（占位）：`lockOf` 给按调用所在会话找锁记录用（P1-11 的实现读它，这里不读） */
export function createDesktopToolHost(_options: {
  lockOf: (sessionId: string) => LockRecord | undefined
}): ToolHost {
  return {
    buildBuiltinTools: () => [],
    resolveAgentTools: async () => ({ sandboxed: false }),
    rebuildAgentTools: () => ({})
  }
}

/** 桌面 PromptHost（占位）：一个 seam 都不实现 */
export const desktopPromptHost: PromptHost = {}

/** 桌面人设变量表（占位）：空表 */
export function desktopPromptVars(_ctx: PromptVarsCtx): PromptVars | Promise<PromptVars> {
  return {}
}
