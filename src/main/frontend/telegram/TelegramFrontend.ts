import type { Bot } from 'grammy'
import type { ChatFrontend, ChatFrontendCapabilities, ChatEvent } from '../core'
import { v4 as uuid } from 'uuid'
import {
  extractMessageContent,
  formatApprovalMessage,
  formatAskMessage,
  formatAssistantText
} from './messageFormatter'
import { TelegramRateLimiter } from './rateLimiter'
import { createLogger } from '../../logger'

const log = createLogger('Telegram:Frontend')

/** Telegram 前端适配器 — 每个绑定的 Telegram chat 一个实例 */
export class TelegramFrontend implements ChatFrontend {
  readonly id: string
  readonly capabilities: ChatFrontendCapabilities = {
    streaming: false,
    toolApproval: true,
    userInput: true,
    sshCredentials: false
  }

  private alive = true
  private rateLimiter = new TelegramRateLimiter()
  /** ask 工具多选时暂存的选项 */
  private askSelections = new Map<string, Set<number>>()

  constructor(
    private bot: Bot,
    readonly chatId: number,
    readonly sessionId: string,
    readonly userId: number
  ) {
    this.id = `tg-${chatId}-${uuid().slice(0, 8)}`
  }

  sendEvent(event: ChatEvent): void {
    if (!this.alive || event.sessionId !== this.sessionId) return
    this.handleEvent(event).catch((err) => {
      log.warn(`发送失败 chat=${this.chatId}: ${err}`)
    })
  }

  isAlive(): boolean {
    return this.alive
  }

  destroy(): void {
    this.alive = false
    this.askSelections.clear()
  }

  // ─── ask 工具多选支持 ──────────────────────────

  toggleAskSelection(toolCallId: string, index: number): void {
    let selections = this.askSelections.get(toolCallId)
    if (!selections) {
      selections = new Set()
      this.askSelections.set(toolCallId, selections)
    }
    if (selections.has(index)) {
      selections.delete(index)
    } else {
      selections.add(index)
    }
  }

  getAskSelections(toolCallId: string): number[] {
    const selections = this.askSelections.get(toolCallId)
    this.askSelections.delete(toolCallId)
    return selections ? Array.from(selections).sort() : []
  }

  // ─── 内部事件分发 ──────────────────────────────

  private async handleEvent(event: ChatEvent): Promise<void> {
    switch (event.type) {
      case 'user_message':
        // Telegram 用户已看到自己发送的消息，跳过
        break

      case 'agent_start':
        await this.sendTypingAction()
        break

      case 'step_end':
        // 中间步骤不发送，只在 agent_end 发最终回复
        break

      case 'agent_end': {
        const content = extractMessageContent(event.message)
        if (content) {
          await this.sendText(formatAssistantText(content))
        }
        break
      }

      case 'tool_start':
      case 'tool_end':
        // 工具执行过程不发送，减少消息噪音
        break

      case 'tool_approval_request': {
        const { text, keyboard } = formatApprovalMessage(event)
        await this.sendWithKeyboard(text, keyboard)
        break
      }

      case 'user_input_request': {
        const { text, keyboard } = formatAskMessage(event)
        await this.sendWithKeyboard(text, keyboard)
        break
      }

      case 'error':
        await this.sendText(`⚠️ ${event.error}`)
        break

      case 'image_data':
        try {
          const { data, mimeType } = JSON.parse(event.image)
          const buffer = Buffer.from(data, 'base64')
          await this.rateLimiter.enqueue(() =>
            this.bot.api
              .sendPhoto(
                this.chatId,
                new InputFile(buffer, `image.${mimeType.split('/')[1] || 'png'}`)
              )
              .then(() => {})
          )
        } catch {
          // 图片发送失败，静默忽略
        }
        break

      default:
        break
    }
  }

  private async sendTypingAction(): Promise<void> {
    await this.rateLimiter.enqueue(() =>
      this.bot.api.sendChatAction(this.chatId, 'typing').then(() => {})
    )
  }

  private async sendText(text: string): Promise<void> {
    if (!text) return
    await this.rateLimiter.enqueue(() => this.bot.api.sendMessage(this.chatId, text).then(() => {}))
  }

  private async sendWithKeyboard(text: string, keyboard: InlineKeyboard): Promise<void> {
    await this.rateLimiter.enqueue(() =>
      this.bot.api.sendMessage(this.chatId, text, { reply_markup: keyboard }).then(() => {})
    )
  }
}

// grammy re-exports for inline usage
import { InputFile, InlineKeyboard } from 'grammy'
