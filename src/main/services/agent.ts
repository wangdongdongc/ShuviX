import { Agent, type AgentEvent } from '@mariozechner/pi-agent-core'
import { getModel, streamSimple } from '@mariozechner/pi-ai'
import type { BrowserWindow } from 'electron'
import { httpLogService } from './httpLogService'

// Agent 事件类型（用于 IPC 通信）
export interface AgentStreamEvent {
  type: 'text_delta' | 'text_end' | 'thinking_delta' | 'agent_start' | 'agent_end' | 'error'
  data?: string
  error?: string
}

/**
 * Agent 服务 — 封装 pi-agent-core，在 Main Process 中运行
 * 通过 IPC 将事件流转发到 Renderer Process
 */
export class AgentService {
  private agent: Agent | null = null
  private mainWindow: BrowserWindow | null = null
  private activeSessionId = ''

  /** 绑定主窗口，用于发送 IPC 事件 */
  setWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /** 创建新的 Agent 实例 */
  createAgent(
    sessionId: string | undefined,
    provider: string,
    model: string,
    systemPrompt: string,
    apiKey?: string,
    baseUrl?: string
  ): void {
    this.activeSessionId = sessionId || ''

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

    this.agent = new Agent({
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
            if (!this.activeSessionId) return
            httpLogService.logRequest({
              sessionId: this.activeSessionId,
              provider: String(streamModel.provider || provider),
              model: String(streamModel.id || model),
              payload
            })
          }
        })
    })

    // 订阅 Agent 事件，转发到 Renderer
    this.agent.subscribe((event: AgentEvent) => {
      this.forwardEvent(event)
    })
  }

  /** 发送消息给 Agent */
  async prompt(text: string): Promise<void> {
    if (!this.agent) {
      this.sendToRenderer({ type: 'error', error: 'Agent 未初始化' })
      return
    }

    try {
      await this.agent.prompt(text)
    } catch (err: any) {
      this.sendToRenderer({ type: 'error', error: err.message || String(err) })
    }
  }

  /** 中止当前生成 */
  abort(): void {
    this.agent?.abort()
  }

  /** 切换模型 */
  setModel(provider: string, model: string, baseUrl?: string): void {
    if (!this.agent) return
    const resolvedModel = getModel(provider as any, model as any)
    if (baseUrl) {
      resolvedModel.baseUrl = baseUrl
    }
    this.agent.setModel(resolvedModel)
  }

  /** 获取当前消息列表 */
  getMessages(): any[] {
    return this.agent?.state.messages ?? []
  }

  /** 清除消息历史 */
  clearMessages(): void {
    if (this.agent) {
      this.agent.state.messages = []
    }
  }

  /** 将 pi-agent-core 事件转换并发送到 Renderer */
  private forwardEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.sendToRenderer({ type: 'agent_start' })
        break
      case 'agent_end':
        this.sendToRenderer({ type: 'agent_end' })
        break
      case 'message_update': {
        const msgEvent = event.assistantMessageEvent
        if (msgEvent.type === 'text_delta') {
          this.sendToRenderer({ type: 'text_delta', data: msgEvent.delta })
        } else if (msgEvent.type === 'thinking_delta') {
          this.sendToRenderer({ type: 'thinking_delta', data: msgEvent.delta })
        }
        break
      }
      case 'message_end':
        this.sendToRenderer({ type: 'text_end' })
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
