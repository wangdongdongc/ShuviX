import { Agent, type AgentEvent } from '@mariozechner/pi-agent-core'
import { getModel, streamSimple } from '@mariozechner/pi-ai'
import type { BrowserWindow } from 'electron'
import { httpLogService } from './httpLogService'

// Agent 事件类型（用于 IPC 通信，每个事件都携带 sessionId）
export interface AgentStreamEvent {
  type: 'text_delta' | 'text_end' | 'thinking_delta' | 'agent_start' | 'agent_end' | 'error'
  sessionId: string
  data?: string
  error?: string
}

/**
 * Agent 服务 — 管理多个独立的 Agent 实例，按 sessionId 隔离
 * 每个 session 拥有自己的 Agent，互不影响
 */
export class AgentService {
  private agents = new Map<string, Agent>()
  private mainWindow: BrowserWindow | null = null

  /** 绑定主窗口，用于发送 IPC 事件 */
  setWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /** 为指定 session 创建 Agent 实例（已存在则跳过） */
  createAgent(
    sessionId: string,
    provider: string,
    model: string,
    systemPrompt: string,
    apiKey?: string,
    baseUrl?: string
  ): void {
    if (this.agents.has(sessionId)) {
      return
    }
    console.log(`[Agent] 创建 session=${sessionId} provider=${provider} model=${model}`)

    // 设置 API Key 环境变量
    if (apiKey) {
      const envMap: Record<string, string> = {
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        google: 'GOOGLE_API_KEY'
      }
      const envKey = envMap[provider]
      if (envKey) {
        process.env[envKey] = apiKey
      }
    }

    const resolvedModel = getModel(provider as any, model as any)

    // 如果用户设置了自定义 Base URL，覆盖模型默认值
    if (baseUrl) {
      resolvedModel.baseUrl = baseUrl
    }

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: resolvedModel,
        thinkingLevel: 'off',
        messages: [],
        tools: []
      },
      streamFn: (streamModel, context, options) =>
        streamSimple(streamModel, context, {
          ...(options || {}),
          onPayload: (payload) => {
            httpLogService.logRequest({
              sessionId,
              provider: String(streamModel.provider || provider),
              model: String(streamModel.id || model),
              payload
            })
          }
        })
    })

    this.agents.set(sessionId, agent)

    // 订阅 Agent 事件，转发到 Renderer（携带 sessionId）
    agent.subscribe((event: AgentEvent) => {
      this.forwardEvent(sessionId, event)
    })
  }

  /** 向指定 session 的 Agent 发送消息 */
  async prompt(sessionId: string, text: string): Promise<void> {
    const agent = this.agents.get(sessionId)
    if (!agent) {
      console.log(`[Agent] prompt 失败，未找到 session=${sessionId}`)
      this.sendToRenderer({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }

    console.log(`[Agent] prompt session=${sessionId} text=${text.slice(0, 50)}...`)
    try {
      await agent.prompt(text)
    } catch (err: any) {
      this.sendToRenderer({ type: 'error', sessionId, error: err.message || String(err) })
    }
  }

  /** 中止指定 session 的生成 */
  abort(sessionId: string): void {
    console.log(`[Agent] 中止 session=${sessionId}`)
    this.agents.get(sessionId)?.abort()
  }

  /** 切换指定 session 的模型 */
  setModel(sessionId: string, provider: string, model: string, baseUrl?: string): void {
    const agent = this.agents.get(sessionId)
    if (!agent) return
    const resolvedModel = getModel(provider as any, model as any)
    if (baseUrl) {
      resolvedModel.baseUrl = baseUrl
    }
    agent.setModel(resolvedModel)
    console.log(`[Agent] 切换模型 session=${sessionId} provider=${provider} model=${model}`)
  }

  /** 获取指定 session 的消息列表 */
  getMessages(sessionId: string): any[] {
    return this.agents.get(sessionId)?.state.messages ?? []
  }

  /** 清除指定 session 的消息历史 */
  clearMessages(sessionId: string): void {
    const agent = this.agents.get(sessionId)
    if (agent) {
      agent.state.messages = []
    }
  }

  /** 移除指定 session 的 Agent（删除会话时调用） */
  removeAgent(sessionId: string): void {
    const agent = this.agents.get(sessionId)
    if (agent) {
      agent.abort()
      this.agents.delete(sessionId)
      console.log(`[Agent] 移除 session=${sessionId} 剩余=${this.agents.size}`)
    }
  }

  /** 将 pi-agent-core 事件转换并发送到 Renderer */
  private forwardEvent(sessionId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        console.log(`[Agent] 开始生成 session=${sessionId}`)
        this.sendToRenderer({ type: 'agent_start', sessionId })
        break
      case 'agent_end':
        console.log(`[Agent] 生成完成 session=${sessionId}`)
        this.sendToRenderer({ type: 'agent_end', sessionId })
        break
      case 'message_update': {
        const msgEvent = event.assistantMessageEvent
        if (msgEvent.type === 'text_delta') {
          this.sendToRenderer({ type: 'text_delta', sessionId, data: msgEvent.delta })
        } else if (msgEvent.type === 'thinking_delta') {
          this.sendToRenderer({ type: 'thinking_delta', sessionId, data: msgEvent.delta })
        }
        break
      }
      case 'message_end':
        this.sendToRenderer({ type: 'text_end', sessionId })
        break
      default:
        break
    }
  }

  /** 发送事件到 Renderer */
  private sendToRenderer(event: AgentStreamEvent): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('agent:event', event)
    }
  }
}

// 全局单例
export const agentService = new AgentService()
