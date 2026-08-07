/**
 * 派生 Agent 协调器（桌面装配）—— 复用 @shuvix/agent-runtime 的 createSubAgentManager 内核。
 *
 * 执行/事件管线/abort/深度校验全在共享核心（派生 agent 与会话根 agent 共用
 * HarnessSession 运行时，会话树为内存态 InMemorySessionStorage）；桌面只注入端适配：
 *   - resolveTools：内置工具注册表 + MCP + Skill，经 wrapToolOutput 截断/落盘；
 *     定义白名单声明 'Agent' 的派生 agent 注入派发工具（opt-in；层级由内核 MAX_AGENT_DEPTH 校验）
 *   - buildModel：agentModelResolver.resolveModel（providerDao 取 baseUrl/protocol/key）
 *   - getApiKey：providerDao
 *   - broadcast：chatFrontendRegistry
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import {
  createSubAgentManager,
  type AnyAgentTool,
  type InProcessAgentType,
  type SpawnContext
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
import { requestUserInputFor } from '../services/userInputBroker'
import { httpLogService } from '../services/httpLogService'
import { t } from '../i18n'
import { createLogger } from '../logger'
import { createAgentTool } from './AgentTool'

export type { InProcessAgentType }

const log = createLogger('Agent')

// ─── 桌面工具解析（内置/MCP/Skill + 输出包装） ──────────────────

function pickOverrides(tool: object): ProcessToolOutputOverrides | undefined {
  const t = tool as { outputMaxBytes?: number; outputMaxLines?: number }
  if (t.outputMaxBytes == null && t.outputMaxLines == null) return undefined
  return { maxBytes: t.outputMaxBytes, maxLines: t.outputMaxLines }
}

function buildSubAgentTools(
  ctx: ToolContext,
  agentType: InProcessAgentType,
  spawn: SpawnContext
): AnyAgentTool[] {
  // ctx.requestUserInput 由 manager 经 SubAgentToolHelpers 绑定根会话注入：
  // 派生 agent 工具（ask / 路径审批 / git resolveDir 审批）的表单出现在根会话对话流。
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

  // 派发工具按白名单 opt-in：定义在 tools 里显式声明 'Agent' 才注入（定义即能力上限，
  // 未声明不得经派发提权）；parentSessionId 用本 agent 的 id，使嵌套派生的子代挂在
  // 本 agent 名下。已达层级上限（canSpawn=false）时同样省略，不给 LLM 一个必然报错的工具。
  // 注：上方按名解析循环里 'Agent' 注册项无 factory 会被跳过，此处是它唯一的注入点。
  if (agentType.tools.includes('Agent') && spawn.canSpawn) {
    tools.push(
      wrap(
        createAgentTool(
          { sessionId: spawn.agentId },
          { modelConfig: spawn.modelConfig, rootSessionId: spawn.rootSessionId }
        )
      )
    )
  }

  return tools
}

// ─── 子智能体管理器（共享核心 + 桌面注入） ──────────────────────

export const agentManager = createSubAgentManager({
  resolveTools: (agentType, rootSessionId, helpers, spawn) =>
    buildSubAgentTools(
      {
        sessionId: rootSessionId,
        requestUserInput: helpers?.requestUserInput,
        // 派生 agent 工具的单向前端通知（preview / SSH runtime 等）归属到根会话展示
        emitChatEvent: (event) =>
          chatFrontendRegistry.broadcast({ ...event, sessionId: rootSessionId } as ChatEvent)
      },
      agentType,
      spawn
    ),
  // 派生 agent 审批/询问转发到根会话（sessionService 在 userInputBroker 注册 resolver）
  requestUserInput: (rootSessionId, req) => requestUserInputFor(rootSessionId, req),
  buildModel: (cfg) =>
    resolveModel({ provider: cfg.provider, model: cfg.model, capabilities: cfg.capabilities }),
  getApiKey: (p) => providerDao.pick(p, ['apiKey'])?.apiKey || undefined,
  broadcast: (event) => chatFrontendRegistry.broadcast(event),
  logger: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
  getAbortedNote: () => t('agent.toolAborted') || 'Aborted by user.',
  // 派生 agent LLM 请求也记入 LLM 日志（归到根会话，便于在日志里按可见会话查看）
  httpLog: {
    logRequest: (params) => httpLogService.logRequest(params),
    updateUsage: (logId, input, output, total, responseJson) =>
      httpLogService.updateUsage(logId, input, output, total, responseJson)
  }
})
