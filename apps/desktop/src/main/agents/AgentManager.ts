/**
 * 子智能体会话管理器（桌面装配）—— 复用 @shuvix/agent-runtime 的 createSubAgentManager 内核。
 *
 * 执行/事件转发/abort 等逻辑全在共享核心；桌面只注入端适配：
 *   - resolveTools：内置工具注册表 + MCP + Skill，经 wrapToolOutput 截断/落盘
 *   - buildModel：agentModelResolver.resolveModel（providerDao 取 baseUrl/protocol/key）
 *   - getApiKey：providerDao
 *   - broadcast：chatFrontendRegistry
 *   - onRegister/onUnregister：transientSessionRegistry（供 IPC 分叉 + 右侧面板发现）
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'
import {
  createSubAgentManager,
  type AnyAgentTool,
  type InProcessAgentType
} from '@shuvix/agent-runtime'
import { getBuiltinToolEntries } from '../services/toolRegistry'
import { SkillTool } from '../services/skillTool'
import type { ToolContext } from '../services/toolContext'
import { resolveModel } from '../services/agentModelResolver'
import { providerDao } from '../dao/providerDao'
import { mcpService } from '../services/mcpService'
import {
  wrapToolOutput,
  getOutputStrategy,
  type ProcessToolOutputOverrides
} from '../services/wrapToolOutput'
import { chatFrontendRegistry } from '../frontend/core'
import { transientSessionRegistry } from './transientSessionRegistry'
import { httpLogService } from '../services/httpLogService'
import { t } from '../i18n'
import { createLogger } from '../logger'

export type { InProcessAgentType }

const log = createLogger('Agent')

// ─── 桌面工具解析（内置/MCP/Skill + 输出包装） ──────────────────

function pickOverrides(tool: object): ProcessToolOutputOverrides | undefined {
  const t = tool as { outputMaxBytes?: number; outputMaxLines?: number }
  if (t.outputMaxBytes == null && t.outputMaxLines == null) return undefined
  return { maxBytes: t.outputMaxBytes, maxLines: t.outputMaxLines }
}

function buildSubAgentTools(ctx: ToolContext, agentType: InProcessAgentType): AnyAgentTool[] {
  const tools: AnyAgentTool[] = []
  const builtinEntries = getBuiltinToolEntries()
  const builtinMap = new Map(builtinEntries.filter((e) => e.factory).map((e) => [e.name, e]))
  const skillNames: string[] = []
  const wrap = (tool: object): AnyAgentTool =>
    wrapToolOutput(
      tool as AgentTool<TSchema, unknown>,
      ctx.sessionId,
      getOutputStrategy(tool),
      pickOverrides(tool)
    ) as unknown as AnyAgentTool

  for (const toolName of agentType.tools) {
    if (toolName.startsWith('mcp:')) {
      const serverName = toolName.slice(4)
      for (const mcpTool of mcpService.getAgentToolsByServerName(serverName)) {
        tools.push(wrap(mcpTool))
      }
    } else if (toolName.startsWith('skill:')) {
      skillNames.push(toolName.slice(6))
    } else {
      const entry = builtinMap.get(toolName)
      if (entry?.factory) {
        tools.push(wrap(entry.factory(ctx)))
      }
    }
  }

  if (skillNames.length > 0) {
    tools.push(wrap(new SkillTool(skillNames)))
  }

  return tools
}

// ─── 子智能体管理器（共享核心 + 桌面注入） ──────────────────────

export const agentManager = createSubAgentManager({
  resolveTools: (agentType, parentSessionId) =>
    buildSubAgentTools({ sessionId: parentSessionId }, agentType),
  buildModel: (cfg) =>
    resolveModel({ provider: cfg.provider, model: cfg.model, capabilities: cfg.capabilities }),
  getApiKey: (p) => providerDao.pick(p, ['apiKey'])?.apiKey || undefined,
  broadcast: (event) => chatFrontendRegistry.broadcast(event),
  logger: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
  getAbortedNote: () => t('agent.toolAborted') || 'Aborted by user.',
  onRegister: (meta) =>
    transientSessionRegistry.register({
      sessionId: meta.subSessionId,
      parentSessionId: meta.parentSessionId,
      subAgentName: meta.subAgentName,
      displayName: meta.displayName,
      description: meta.description
    }),
  onUnregister: (subSessionId) => transientSessionRegistry.unregister(subSessionId),
  // 子代理 LLM 请求也记入 LLM 日志（归到父会话，便于在日志里按可见会话查看）
  httpLog: {
    logRequest: (params) => httpLogService.logRequest(params),
    updateUsage: (logId, input, output, total, responseJson) =>
      httpLogService.updateUsage(logId, input, output, total, responseJson)
  }
})
