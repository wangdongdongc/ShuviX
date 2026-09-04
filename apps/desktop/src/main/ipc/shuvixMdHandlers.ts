import { ipcMain } from 'electron'
import { parseBotDefinitionFile, validateShuvixMdText } from '@shuvix/agent-runtime'
import type { BotPipelineOptions } from '@shuvix/chat-protocol/botPipeline'
import { botService } from '../services/botService'
import { workflowService } from '../services/workflowService'
import { agentService } from '../services/agentService'

/**
 * shuvix 契约 md 的解析器级校验 —— frontmatter 属性卡（app-shell）经 ChatApi
 * `shuvixMd.validate` 调用。纯函数复用 agent-runtime 的真解析器（合法性语义的
 * 唯一事实源），无状态、不落盘。
 *
 * bot 类型在合法之上再追加**注册表层面的提示**（`botService.advise`：管线 / 槽位 / agent
 * 的存在性与必填）—— 状态仍是 valid，卡片据 messages 亮琥珀。解析器只判形状，这些事实
 * 只有对照注册表才知道，所以放在桌面这一层而不是 agent-runtime 的纯函数里。
 */
export function registerShuvixMdHandlers(): void {
  ipcMain.handle(
    'shuvixMd:validate',
    (_event, params: { type: string; text: string; name?: string }) => {
      const result = validateShuvixMdText(params.type, params.text, params.name)
      if (params.type !== 'bot' || result.status !== 'valid') return result
      // 属性卡送的是 frontmatter 片段（无正文）；正文可为空，解析器照常接受
      const bot = parseBotDefinitionFile(params.text, params.name ?? 'file')
      if (!bot) return result
      return { ...result, messages: [...result.messages, ...botService.advise(bot)] }
    }
  )

  /** bot 管线字段的候选项：生效的工作流（含声明的槽位）+ 生效的 agent 名 */
  ipcMain.handle('shuvixMd:botPipelineOptions', (): BotPipelineOptions => {
    const workflows = workflowService
      .listForSettings()
      .filter((w) => !w.overridden)
      .map((w) => ({
        name: w.name,
        source: w.source,
        concurrency: w.concurrency,
        slots: workflowService.agentSlots(w.name)
      }))
    const agents = agentService
      .listForSettings()
      .filter((a) => !a.overridden)
      .map((a) => a.name)
    return { workflows, agents }
  })
}
