import {
  DEFAULT_PROFILE_NAME,
  clearSessionDecisions,
  generateSessionTitle,
  SessionTitler,
  resolveInitialThinkingLevel,
  toInProcessAgentType,
  type CreatedAgent,
  type HarnessSession,
  type InlineTokensSidecar
} from '@shuvix/agent-runtime'
import { messageService } from './messageService'
import { providerDao } from '../dao/providerDao'
import { sessionDao } from '../dao/sessionDao'
import { t } from '../i18n'
import { broadcastSessionTitleChanged } from '../utils/sessionConfigBroadcast'
import { agentService } from './agentService'
import { agentFactory } from '../agents/agentHost'
import { resolveModel } from './agentModelResolver'
import { clearSession as clearFileTimeSession } from '../utils/toolUtils/fileTime'
import { sshManager } from './sshManager'
import type { ModelCapabilities, ThinkingLevel, AgentRuntimeInfo } from '../types'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { SessionModelMetadata } from '../dao/types'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { settingsDao } from '../dao/settingsDao'
import { createLogger } from '../logger'

const log = createLogger('AgentSession')

// 注：原 buildSystemPrompt 已收敛到统一创建管线 —— persona/workspace/project 三个
// 具名段 provider 见 agents/agentHost.ts；笔记本复用见 renderDefaultSystemPrompt。

/** AgentSession.create 工厂参数 */
export interface AgentSessionCreateParams {
  sessionId: string
  provider: string
  model: string
  capabilities: ModelCapabilities
  workingDirectory: string
  enabledTools: string[]
  modelMetadata?: SessionModelMetadata
  /**
   * 会话根 Agent 的档案名（settings.agentProfile 解析结果；缺省 'default'）。
   * 档案在解析侧已确认存在，这里仍保留 getProfile 的 default 兜底。
   */
  profileName?: string
}

/**
 * AgentSession — 封装单个 session 的所有 Agent 状态和操作（桌面宿主）。
 *
 * 创建/装配（systemPrompt 组装、工具解析、指令注入）已收敛到统一创建管线
 * （agents/agentHost 的 agentFactory + 'default' 档案）；本类保留桌面特有的
 * 生命周期编排：titler、generateTitle、setModel 的能力查询、ssh / fileTime 清理。
 *
 * 通过 AgentSession.create() 工厂方法创建。
 */
export class AgentSession {
  readonly sessionId: string

  private created: CreatedAgent
  private runtime: HarnessSession

  // 标题自动生成（两阶段：首轮快速 + 精修一次）—— 策略在 @shuvix/agent-runtime 与扩展端共用
  private readonly titler: SessionTitler

  private constructor(sessionId: string, created: CreatedAgent) {
    this.sessionId = sessionId
    this.created = created
    this.runtime = created.runtime
    this.titler = new SessionTitler({
      getCurrentTitle: () => sessionDao.pick(sessionId, ['title'])?.title ?? null,
      getDefaultTitle: () => t('agent.defaultTitle'),
      listMessages: () => messageService.listBySession(sessionId),
      generate: (conversationText) => this.generateTitle(conversationText),
      // 落库 + 广播 AppEvent，各端统一刷新会话列表标题
      applyTitle: (title) => {
        sessionDao.updateTitle(sessionId, title)
        broadcastSessionTitleChanged(sessionId, title)
      },
      warn: (message) => log.warn(message)
    })
  }

  /** 工厂方法：经统一创建管线（agentFactory + 会话档案）构建完整的 AgentSession */
  static async create(params: AgentSessionCreateParams): Promise<AgentSession> {
    const {
      sessionId,
      provider,
      model,
      capabilities,
      workingDirectory,
      enabledTools,
      modelMetadata,
      profileName
    } = params

    // 会话档案（`/<agentName>` 斜杠命令切换，粘性存 settings.agentProfile）；缺省 'default'。
    // 'default' 可被用户 ~/.shuvix/agents/default.md 覆盖（getProfile 有内置兜底，恒存在）。
    const profile = toInProcessAgentType(
      agentService.getProfile(profileName ?? DEFAULT_PROFILE_NAME) ??
        agentService.getProfile(DEFAULT_PROFILE_NAME)!
    )

    // 前向引用：onPromptAccepted 在 agent 执行期才触发，构造期不会调用
    // eslint-disable-next-line prefer-const
    let session: AgentSession

    const created = await agentFactory.createAgent({
      kind: 'root',
      sessionId,
      profile,
      model: { provider, model, capabilities },
      thinkingLevel: resolveInitialThinkingLevel({
        persisted: modelMetadata?.thinkingLevel,
        reasoning: capabilities.reasoning
      }),
      cwd: workingDirectory,
      // 会话勾选（mcp:/skill:）作为 overlay 叠加在档案工具白名单上
      toolOverlay: enabledTools,
      // UserPromptSubmit 通过、正式派发前触发首轮快速标题（保持与旧行为一致的并发时序）
      onPromptAccepted: (text) => void session.titler.quick(text)
    })

    session = new AgentSession(sessionId, created)
    return session
  }

  // ─── Public API ──────────────────────────────────────

  /**
   * 向 Agent 发送消息（支持附带图片）。
   *
   * 首轮快速标题经注入的 `onPromptAccepted` 在派发前触发（各端一致）。
   */
  async prompt(
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>,
    display?: InlineTokensSidecar
  ): Promise<void> {
    log.info(
      `prompt session=${this.sessionId} text=${text.slice(0, 50)}... images=${images?.length || 0}`
    )

    await this.runtime.prompt(text, images, display)

    // 精修：agent 首轮回复落库后，用更完整上下文重生成一次（不 await）
    void this.titler.refine()
  }

  // 注：指令文件/项目提示词随 createAgent 直接 append 进系统提示词（不再有懒注入步骤）。

  /** 向运行中的 Agent 注入 steer 消息 */
  async steer(text: string): Promise<void> {
    await this.runtime.steer(text)
  }

  /** 送达系统侧通知（运行中即刻插话，空闲则搭下一条用户消息的便车） */
  async notify(text: string): Promise<void> {
    await this.runtime.notify(text)
  }

  /** 本轮结束前追加消息，继续同一次运行（harness 新增能力） */
  async followUp(text: string): Promise<void> {
    await this.runtime.followUp(text)
  }

  /** 排队到下一次 prompt 之前（harness 新增能力；不被 abort 清空） */
  async nextTurn(text: string): Promise<void> {
    await this.runtime.nextTurn(text)
  }

  /** 中止生成 */
  async abort(): Promise<void> {
    await this.runtime.abort()
  }

  /** 切换模型（查 provider 模型能力 → 统一管线 applyModel，同步更新派发工具的模型配置） */
  async setModel(
    provider: string,
    model: string,
    baseUrl?: string,
    apiProtocol?: string
  ): Promise<void> {
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const caps: ModelCapabilities = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}
    // 切模型保留当前思考深度（CreatedAgent.applyModel 内省略档位 → harness 保持不变）
    await this.created.applyModel({ provider, model, capabilities: caps }, { baseUrl, apiProtocol })
  }

  /** 设置思考深度 */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.runtime.setThinkingLevel(level)
  }

  /** 动态更新会话工具 overlay（档案基座 + 新勾选重解析 → applyTools） */
  async setEnabledTools(enabledTools: string[]): Promise<void> {
    await this.created.applyToolOverlay(enabledTools)
    log.info(`setEnabledTools session=${this.sessionId} tools=[${enabledTools.join(',')}]`)
  }

  /** 当前上下文对应的 UI 消息列表 */
  async listChatMessages(): Promise<ChatMessage[]> {
    return await this.runtime.listChatMessages()
  }

  /** 运行时信息快照（读 harness 状态 + session 上下文，供设置页「监视器 → 智能体」展开时展示） */
  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return await this.runtime.getRuntimeInfo()
  }

  /**
   * AI 生成简短标题（使用 settings 中配置的 titleProvider / titleModel）。
   */
  async generateTitle(conversationText: string): Promise<string | null> {
    const titleProvider = settingsDao.findByKey('general.titleProvider')
    const titleModelId = settingsDao.findByKey('general.titleModel')
    if (!titleProvider || !titleModelId) return null

    const providerRow = providerDao.pick(titleProvider, ['apiKey'])
    if (!providerRow?.apiKey) {
      log.warn(`标题模型 provider ${titleProvider} 无 API Key,跳过标题生成`)
      return null
    }

    try {
      const modelRow = providerDao
        .findModelsByProvider(titleProvider)
        .find((m) => m.modelId === titleModelId)
      const caps = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}
      const model = resolveModel({
        provider: titleProvider,
        model: titleModelId,
        capabilities: caps
      })
      // LLM 调用 + 解析复用共享内核（与扩展同源）
      return await generateSessionTitle({ model, apiKey: providerRow.apiKey, conversationText })
    } catch (err) {
      log.error(`生成标题失败: ${err}`)
    }
    return null
  }

  // ─── 用户输入挂起 / 响应（委托 runtime） ────────────────

  requestUserInput(request: InputRequest): Promise<InputResponse> {
    return this.runtime.requestUserInput(request)
  }

  respondToInput(requestId: string, response: InputResponse): boolean {
    return this.runtime.respondToInput(requestId, response)
  }

  // ─── 生命周期 ──────────────────────────────────────

  /**
   * 使 Agent 失效（回退时使用，下次 init 会重建）。
   *
   * 这里的运行时**被弃用**（下次 ensure 重建一个新的），故必须从运行时注册中心注销 ——
   * 漏注销会在监控页留下一个指向死 harness 的条目。派生 agent 不受影响：它们不随
   * 根运行时重建而失效。
   *
   * **必须 await**：`abort()` 内部要等当前 run 真正跑完（pi 的 waitForIdle）。以前这里是
   * fire-and-forget，运行时被立刻解绑，下一条消息就会造出第二个运行时 —— 两个 run 往同一棵
   * 会话树上交叉写，`tool_use`/`tool_result` 配对作废，之后每一发请求都被 provider 打回。
   * 关不掉就一直等（会话呈现「正在停止」），绝不让第二个运行时出生。
   */
  async invalidate(): Promise<void> {
    await this.abortQuietly()
    this.created.dispose()
    clearFileTimeSession(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`invalidate session=${this.sessionId}`)
  }

  /** 完全销毁（删除会话时调用）。不 cascade 到子智能体。 */
  async destroy(): Promise<void> {
    await this.abortQuietly()
    this.created.dispose()
    clearFileTimeSession(this.sessionId)
    clearSessionDecisions(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`destroy session=${this.sessionId}`)
  }

  /**
   * 关停当前 run。abort 抛错只记日志：清理链路的其余步骤仍要走完，
   * 而「run 已停」这个保证由 abort 自身的 waitForIdle 提供，抛错时它已经不在跑了。
   */
  private async abortQuietly(): Promise<void> {
    try {
      await this.runtime.abort()
    } catch (err) {
      log.warn(`中止运行时失败 session=${this.sessionId}: ${err}`)
    }
  }
}
