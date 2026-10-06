import { ipcMain } from 'electron'
import { chatGateway, operationContext, createElectronContext } from '../frontend'
import { getBuiltinToolPresentations } from '../services/toolRegistry'
import { getBuiltinToolDefinitions } from '../services/agentToolBuilder'
import { agentManager } from '../agents/AgentManager'
import { getAgentRuntimeDetail, listAgentRuntimes } from '../services/agentMonitorService'
import type {
  AgentInitParams,
  AgentPromptParams,
  AgentSubAgentPromptParams,
  AgentSteerParams,
  AgentFollowUpParams,
  AgentNextTurnParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams
} from '../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { createLogger } from '../logger'
import { clientIdOf } from '../frontend/sync/clientIdentity'

const log = createLogger('AgentIPC')

/**
 * Agent 相关 IPC 处理器
 * 所有操作均通过 sessionId 指定目标 Agent，委托给 ChatGateway
 */
export function registerAgentHandlers(): void {
  /** 开启对话（后端自行查询所有所需信息） */
  ipcMain.handle('agent:init', (_event, params: AgentInitParams) =>
    operationContext.run(createElectronContext(params.sessionId), () =>
      chatGateway.startChat(params.sessionId)
    )
  )

  /** 向指定 session 发送消息（支持附带图片） */
  ipcMain.handle('agent:prompt', (_event, params: AgentPromptParams) =>
    operationContext.run(createElectronContext(params.sessionId), async () => {
      await chatGateway.prompt(params.sessionId, params.text, params.images, params.inlineTokens)
      return { success: true }
    })
  )

  /**
   * 继续与已存在的派生 agent 对话（按 agentId 路由到它的会话与子对话）：追加一轮用户消息
   * （fire-and-forget，不 await 整轮；不认识 / 忙 / 会话没了的拒绝只记日志）
   */
  ipcMain.handle('agent:subAgentPrompt', (_event, params: AgentSubAgentPromptParams) => {
    void agentManager
      .continueTask({
        subSessionId: params.subSessionId,
        text: params.text,
        inlineTokens: params.inlineTokens
      })
      .catch((err: unknown) => {
        log.warn(`派生 agent 追问失败 agent=${params.subSessionId}: ${errorText(err)}`)
      })
    return { success: true }
  })

  /** 向运行中的 Agent 发送 steer 消息（引导/纠正方向） */
  ipcMain.handle('agent:steer', (_event, params: AgentSteerParams) =>
    operationContext.run(createElectronContext(params.sessionId), () => {
      chatGateway.steer(params.sessionId, params.text)
      return { success: true }
    })
  )

  /** 本轮本应结束时续跑同一次运行（pi followUp 队列） */
  ipcMain.handle('agent:followUp', (_event, params: AgentFollowUpParams) =>
    operationContext.run(createElectronContext(params.sessionId), () => {
      chatGateway.followUp(params.sessionId, params.text)
      return { success: true }
    })
  )

  /** 排队到下一次 prompt 之前（pi nextTurn 队列；不被 abort 清空） */
  ipcMain.handle('agent:nextTurn', (_event, params: AgentNextTurnParams) =>
    operationContext.run(createElectronContext(params.sessionId), () => {
      chatGateway.nextTurn(params.sessionId, params.text)
      return { success: true }
    })
  )

  /** 中止指定 session 的生成（若已有部分内容，后端统一落库并返回） */
  ipcMain.handle('agent:abort', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () => chatGateway.abort(sessionId))
  )

  /**
   * 切换指定 session 的模型。会话已有运行时（含创建中 / 关停中）时拒绝：`success: false`、
   * 什么也不写，前端据此回拉真实状态。
   *
   * 两个 set* 必须 await 网关：运行配置的落点是会话树，不等待就返回的话，调用方 `await`
   * 完再读 `agent.init` 可能还是旧值，网关抛的错也会变成主进程里的 unhandled rejection、
   * 前端恒收到 success。
   */
  ipcMain.handle('agent:setModel', (_event, params: AgentSetModelParams) =>
    operationContext.run(createElectronContext(params.sessionId), async () => ({
      success: await chatGateway.setModel(params.sessionId, params.provider, params.model)
    }))
  )

  /**
   * 销毁会话的根 Agent 运行时（会话横幅 agent 胶囊上的 X）：会话与历史都在，下一条消息按
   * 那时的模型与扩展能力重建。等关停落定才返回；关停前后经 agent_closing 事件广播。
   */
  ipcMain.handle('agent:destroy', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), async () => {
      await chatGateway.destroyAgent(sessionId)
      return { success: true }
    })
  )

  /** 设置指定 session 的思考深度（同 setModel：必须 await 网关） */
  ipcMain.handle('agent:setThinkingLevel', (_event, params: AgentSetThinkingLevelParams) =>
    operationContext.run(createElectronContext(params.sessionId), async () => {
      await chatGateway.setThinkingLevel(params.sessionId, params.level)
      return { success: true }
    })
  )

  /**
   * 统一的"用户输入响应"入口。
   * 命令询问 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由,
   * 后端根据 InputResponse.kind 分发给对应的工具挂起 Promise。
   */
  ipcMain.handle(
    'agent:respondToInput',
    (event, params: { sessionId: string; requestId: string; response: InputResponse }) =>
      operationContext.run(createElectronContext(params.sessionId), () => {
        // 答题方 = 这个窗口（`ipc:<webContentsId>`），只进审计日志（P3-08 PIN-20）
        chatGateway.respondToInput(params.sessionId, params.requestId, params.response, {
          clientId: clientIdOf(event)
        })
        return { success: true }
      })
  )

  /** 读取根 agent 的运行时快照（systemPrompt / 工具 / 模型 / 思考档位）；`ensure` 先创建 agent（不请求
   *  LLM），没有可用模型时答 null（见 DefaultChatGateway.getAgentInfo） */
  ipcMain.handle('agent:getInfo', (_event, sessionId: string, options?: { ensure?: boolean }) =>
    operationContext.run(createElectronContext(sessionId), () =>
      chatGateway.getAgentInfo(sessionId, options)
    )
  )

  /** 获取所有可用工具列表（名称 + 标签 + 可选分组，传 sessionId 时包含项目级 skills） */
  ipcMain.handle('tools:list', (_event, sessionId?: string, options?: { profile?: string }) =>
    operationContext.run(createElectronContext(sessionId), () =>
      chatGateway.listTools(sessionId, options)
    )
  )

  /** 获取所有工具的 UI 渲染配置（图标、摘要字段、表单项等） */
  ipcMain.handle('tools:presentations', () => getBuiltinToolPresentations())

  /** 获取所有内置工具的完整定义（name + description + 参数 schema），供设置页只读展示 */
  ipcMain.handle('tools:definitions', () => getBuiltinToolDefinitions())

  /**
   * 智能体监控：全部活跃 agent 运行时的快照（只读 pi getter + 事件影子，不碰会话树）。
   * 设置页可见时轮询，故刻意不做任何遍历。
   */
  ipcMain.handle('agentMonitor:list', () => listAgentRuntimes())

  /**
   * 智能体监控：单个 agent 的完整运行时快照（系统提示词 / 工具定义 / 上下文消息数）。
   * 只在用户展开某条时调用一次 —— 它要重建上下文，不能进每秒轮询的列表。
   */
  ipcMain.handle('agentMonitor:detail', (_event, agentId: string) => getAgentRuntimeDetail(agentId))

  /**
   * 销毁指定的派生 agent（用户点关闭按钮触发）：在跑就硬中止、卸掉它的扩展、从索引与任务面板移除
   * （转写留着）。等路由做完再答；路由报错只记日志，照样答成功（PIN-17）。
   */
  ipcMain.handle('subSession:destroy', async (_event, subSessionId: string) => {
    await agentManager.destroy(subSessionId).catch((err: unknown) => {
      log.warn(`销毁派生 agent 失败 agent=${subSessionId}: ${errorText(err)}`)
    })
    return { success: true }
  })

  /**
   * 中断运行中的派生 agent（用户点中断按钮触发）：软停止当前生成、保留已产出内容，以「已完成」收尾并
   * 保留在面板。等它停下再答；路由报错只记日志，照样答成功（PIN-17）。
   */
  ipcMain.handle('subSession:interrupt', async (_event, subSessionId: string) => {
    await agentManager.interrupt(subSessionId).catch((err: unknown) => {
      log.warn(`中断派生 agent 失败 agent=${subSessionId}: ${errorText(err)}`)
    })
    return { success: true }
  })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
