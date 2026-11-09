import type { GoalAction } from '@shuvix/chat-protocol/types/goal'
import { goalService } from '../services/goalService'
import { defineHandler } from './registry'
import { chatGateway, operationContext, createClientContext } from '../frontend'
import { inputOriginOfClient } from '../utils/operationContext'
import { getBuiltinToolPresentations } from '../services/toolRegistry'
import { getBuiltinToolDefinitions } from '../services/agentToolBuilder'
import { agentManager } from '../agents/AgentManager'
import { sessionAcl } from '../services/acl'
import { getAgentRuntimeDetail, listAgentRuntimes } from '../services/agentMonitorService'
import type {
  AgentInitParams,
  AgentPromptParams,
  AgentSubAgentPromptParams,
  AgentSteerParams,
  AgentFollowUpParams,
  AgentWithdrawQueuedParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams,
  AgentPreviewChangeParams
} from '../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { createLogger } from '../logger'

const log = createLogger('AgentIPC')

/**
 * Agent 相关 IPC 处理器
 * 所有操作均通过 sessionId 指定目标 Agent，委托给 ChatGateway
 */
export function registerAgentHandlers(): void {
  /** 开启对话（后端自行查询所有所需信息） */
  defineHandler('agent:init', (ctx, params: AgentInitParams) =>
    operationContext.run(createClientContext(ctx, params.sessionId), () =>
      chatGateway.startChat(params.sessionId)
    )
  )

  /** 向指定 session 发送消息（支持附带图片） */
  defineHandler('agent:prompt', (ctx, params: AgentPromptParams) =>
    operationContext.run(createClientContext(ctx, params.sessionId), async () => {
      // 先授权再开跑：agent 的第一步就可能读它们
      sessionAcl.grantAttachedFiles(params.sessionId, params.attachedPaths)
      await chatGateway.prompt(
        params.sessionId,
        params.text,
        params.images,
        params.inlineTokens,
        undefined,
        params.secrets
      )
      return { success: true }
    })
  )

  /**
   * 继续与已存在的派生 agent 对话（按 agentId 路由到它的会话与子对话）：追加一轮用户消息
   * （fire-and-forget，不 await 整轮；不认识 / 忙 / 会话没了的拒绝只记日志）
   */
  defineHandler('agent:subAgentPrompt', (ctx, params: AgentSubAgentPromptParams) => {
    void agentManager
      .continueTask({
        subSessionId: params.subSessionId,
        text: params.text,
        inlineTokens: params.inlineTokens,
        origin: inputOriginOfClient(ctx)
      })
      .catch((err: unknown) => {
        log.warn(`派生 agent 追问失败 agent=${params.subSessionId}: ${errorText(err)}`)
      })
    return { success: true }
  })

  /** 向运行中的 Agent 发送 steer 消息（引导/纠正方向） */
  defineHandler('agent:steer', (ctx, params: AgentSteerParams) =>
    operationContext.run(createClientContext(ctx, params.sessionId), () => {
      sessionAcl.grantAttachedFiles(params.sessionId, params.attachedPaths)
      chatGateway.steer(params.sessionId, params.text, params.secrets)
      return { success: true }
    })
  )

  /** 本轮本应结束时续跑同一次运行（pi followUp 队列） */
  defineHandler('agent:followUp', (ctx, params: AgentFollowUpParams) =>
    operationContext.run(createClientContext(ctx, params.sessionId), () => {
      sessionAcl.grantAttachedFiles(params.sessionId, params.attachedPaths)
      chatGateway.followUp(params.sessionId, params.text, params.secrets)
      return { success: true }
    })
  )

  /** 撤回一条排着的用户输入（P3-11，视图队列的一行）：`{ result }` */
  defineHandler('agent:withdrawQueued', (ctx, params: AgentWithdrawQueuedParams) =>
    operationContext.run(createClientContext(ctx, params.sessionId), async () => ({
      result: await chatGateway.withdrawQueued(params.sessionId, params.submissionId)
    }))
  )

  /** 中止指定 session 的生成（若已有部分内容，后端统一落库并返回） */
  defineHandler('agent:abort', (ctx, sessionId: string) =>
    operationContext.run(createClientContext(ctx, sessionId), () => chatGateway.abort(sessionId))
  )

  /**
   * 继续被中断的工作（P3-12，PIN-17）：等这一轮落定才回（与 prompt 同口径），渲染端不靠它的时机改界面 ——
   * 横幅跟着视图的运行状态走。`{}` → `{ success: true }`；失败 → `{ success: false, error, code }`。
   */
  defineHandler('agent:continue', (ctx, sessionId: string) =>
    operationContext.run(createClientContext(ctx, sessionId), async () => {
      const result = await chatGateway.continue(sessionId)
      if (result.error === undefined) return { success: true }
      return {
        success: false,
        error: result.error,
        ...(result.code === undefined ? {} : { code: result.code })
      }
    })
  )

  /**
   * 切换指定 session 的模型。会话有 Agent 运行时就当场重配它；那个 agent 用不了这个模型时拒绝：
   * `success: false`、什么也不写，前端据此回拉真实状态。
   *
   * 两个 set* 必须 await 网关：运行配置的落点是会话设置，不等待就返回的话，调用方 `await`
   * 完再读 `agent.init` 可能还是旧值，网关抛的错也会变成主进程里的 unhandled rejection、
   * 前端恒收到 success。
   */
  defineHandler('agent:setModel', (ctx, params: AgentSetModelParams) =>
    operationContext.run(createClientContext(ctx, params.sessionId), async () => ({
      success: await chatGateway.setModel(params.sessionId, params.provider, params.model)
    }))
  )

  /** 预判一次模型 / 扩展能力改动会不会让提示词缓存失效（只读：不连服务器、什么也不写） */
  defineHandler('agent:previewChange', (_ctx, { sessionId, ...change }: AgentPreviewChangeParams) =>
    chatGateway.previewAgentChange(sessionId, change)
  )

  /** 冻结的系统提示词与此刻的来源比一比（只读）：界面据此提醒用户「来源改了」 */
  defineHandler('agent:systemPromptStatus', (_ctx, sessionId: string) =>
    chatGateway.systemPromptStatus(sessionId)
  )

  /** 用户点了「重建系统提示词」：会话在跑 → busy；否则删掉冻结的那份，下一条消息按此刻的来源重新渲染 */
  defineHandler('agent:rebuildSystemPrompt', (ctx, sessionId: string) =>
    operationContext.run(createClientContext(ctx, sessionId), () =>
      chatGateway.rebuildSystemPrompt(sessionId)
    )
  )

  /** 各会话挂着几条询问（只读）：窗口重建 / 客户端重连后补侧栏徽标 */
  defineHandler('agent:askCounts', () => chatGateway.pendingAskCounts())

  /** 各会话此刻挂着的询问本身（只读）：收件箱不打开会话就地回答 / 批准，应答仍走 agent:respondToInput */
  defineHandler('agent:pendingInputs', () => chatGateway.pendingInputs())

  /** 目标模式（docs/goal-mode-design.md）：一条会话的目标视图（只读，补种用） */
  defineHandler('agent:goal', (_ctx, sessionId: string) => goalService.get(sessionId))

  /** 对目标的操作：来源按这次操作的连接盖章（设定目标那条消息是人发的） */
  defineHandler('agent:goalAct', (ctx, params: { sessionId: string; action: GoalAction }) =>
    operationContext.run(createClientContext(ctx, params.sessionId), () =>
      goalService.act(params.sessionId, params.action, inputOriginOfClient(ctx))
    )
  )

  /** 有进行中 / 暂停中目标的会话（只读）：侧栏徽标 */
  defineHandler('agent:goalStatuses', () => goalService.statuses())

  /**
   * 销毁会话的根 Agent 运行时（会话横幅 agent 胶囊上的 X）：会话与历史都在，下一条消息按
   * 那时的模型与扩展能力重建。等关停落定才返回；关停前后经 agent_closing 事件广播。
   */
  defineHandler('agent:destroy', (ctx, sessionId: string) =>
    operationContext.run(createClientContext(ctx, sessionId), async () => {
      await chatGateway.destroyAgent(sessionId)
      return { success: true }
    })
  )

  /** 设置指定 session 的思考深度（同 setModel：必须 await 网关） */
  defineHandler('agent:setThinkingLevel', (ctx, params: AgentSetThinkingLevelParams) =>
    operationContext.run(createClientContext(ctx, params.sessionId), async () => {
      await chatGateway.setThinkingLevel(params.sessionId, params.level)
      return { success: true }
    })
  )

  /**
   * 统一的"用户输入响应"入口。
   * 命令询问 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由,
   * 后端根据 InputResponse.kind 分发给对应的工具挂起 Promise。
   */
  defineHandler(
    'agent:respondToInput',
    (
      ctx,
      params: {
        sessionId: string
        requestId: string
        response: InputResponse
        attachedPaths?: string[]
      }
    ) =>
      operationContext.run(createClientContext(ctx, params.sessionId), () => {
        sessionAcl.grantAttachedFiles(params.sessionId, params.attachedPaths)
        // 答题方 = 这个窗口（`ipc:<webContentsId>`），只进审计日志（P3-08 PIN-20）
        chatGateway.respondToInput(params.sessionId, params.requestId, params.response, {
          clientId: ctx.client.id
        })
        return { success: true }
      })
  )

  /** 读取根 agent 的运行时快照（systemPrompt / 工具 / 模型 / 思考档位）；`ensure` 先创建 agent（不请求
   *  LLM），没有可用模型时答 null（见 DefaultChatGateway.getAgentInfo） */
  defineHandler('agent:getInfo', (ctx, sessionId: string, options?: { ensure?: boolean }) =>
    operationContext.run(createClientContext(ctx, sessionId), () =>
      chatGateway.getAgentInfo(sessionId, options)
    )
  )

  /** 获取所有可用工具列表（名称 + 标签 + 可选分组，传 sessionId 时包含项目级 skills） */
  defineHandler('tools:list', (ctx, sessionId?: string, options?: { profile?: string }) =>
    operationContext.run(createClientContext(ctx, sessionId), () =>
      chatGateway.listTools(sessionId, options)
    )
  )

  /** 获取所有工具的 UI 渲染配置（图标、摘要字段、表单项等） */
  defineHandler('tools:presentations', () => getBuiltinToolPresentations())

  /** 获取所有内置工具的完整定义（name + description + 参数 schema），供设置页只读展示 */
  defineHandler('tools:definitions', () => getBuiltinToolDefinitions())

  /**
   * 智能体监控：打开着的会话里每个 agent 的廉价快照（P3-13：`DurableSession.monitorSnapshot()`，只读、
   * 不刷新 LRU、从不打开会话）。面板 / 胶囊可见时每秒轮询。
   */
  defineHandler('agentMonitor:list', () => listAgentRuntimes())

  /**
   * 智能体监控：单个 agent 的完整运行时快照（系统提示词 / 工具定义 / 上下文消息数）。
   * 只在用户展开某条时调用一次 —— 它要重建上下文，不能进每秒轮询的列表。
   */
  defineHandler('agentMonitor:detail', (_ctx, agentId: string) => getAgentRuntimeDetail(agentId))

  /**
   * 销毁指定的派生 agent（用户点关闭按钮触发）：在跑就硬中止、卸掉它的扩展、从索引与任务面板移除
   * （转写留着）。等路由做完再答；路由报错只记日志，照样答成功（PIN-17）。
   */
  defineHandler('subSession:destroy', async (_ctx, subSessionId: string) => {
    await agentManager.destroy(subSessionId).catch((err: unknown) => {
      log.warn(`销毁派生 agent 失败 agent=${subSessionId}: ${errorText(err)}`)
    })
    return { success: true }
  })

  /**
   * 中断运行中的派生 agent（用户点中断按钮触发）：软停止当前生成、保留已产出内容，以「已完成」收尾并
   * 保留在面板。等它停下再答；路由报错只记日志，照样答成功（PIN-17）。
   */
  defineHandler('subSession:interrupt', async (_ctx, subSessionId: string) => {
    await agentManager.interrupt(subSessionId).catch((err: unknown) => {
      log.warn(`中断派生 agent 失败 agent=${subSessionId}: ${errorText(err)}`)
    })
    return { success: true }
  })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
