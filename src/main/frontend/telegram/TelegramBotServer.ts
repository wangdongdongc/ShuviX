import { Bot, type Context } from 'grammy'
import { chatFrontendRegistry, chatGateway, operationContext } from '../core'
import { telegramService } from '../../services/telegramService'
import { TelegramFrontend } from './TelegramFrontend'
import { createTelegramContext } from '../core/OperationContext'
import { compressImageBuffer } from '../../utils/imageProcessing'
import { createLogger } from '../../logger'

const log = createLogger('Telegram:Bot')

/**
 * Telegram Bot 服务器 — 管理 grammY Bot 生命周期
 * 对标 WebUIServer，通过 telegramService.registerServer() 打破循环依赖
 */
class TelegramBotServer {
  private bot: Bot | null = null
  /** chatId → TelegramFrontend */
  private activeFrontends = new Map<number, TelegramFrontend>()

  /** 启动 Bot（long polling） */
  async start(token: string): Promise<void> {
    if (this.bot) return

    const bot = new Bot(token)
    this.bot = bot

    // ─── 命令处理 ──────────────────────────────

    bot.command('start', async (ctx) => {
      if (!this.isAllowedUser(ctx.from?.id)) {
        await ctx.reply('Access denied.')
        return
      }
      await ctx.reply(
        'ShuviX Telegram Bot ready.\n\n' +
          'Send a message to start chatting.\n' +
          'Session binding is managed from the ShuviX desktop app.\n\n' +
          'Commands:\n' +
          '/abort — Stop generation\n' +
          '/status — Show current binding'
      )
    })

    bot.command('abort', async (ctx) => {
      const frontend = this.activeFrontends.get(ctx.chat.id)
      if (!frontend) {
        await ctx.reply('No session bound.')
        return
      }
      chatGateway.abort(frontend.sessionId)
      await ctx.reply('Generation aborted.')
    })

    bot.command('status', async (ctx) => {
      const frontend = this.activeFrontends.get(ctx.chat.id)
      await ctx.reply(
        frontend ? `Bound to session: ${frontend.sessionId.slice(0, 8)}...` : 'No session bound.'
      )
    })

    // ─── 文本消息 → prompt ──────────────────────

    bot.on('message:text', async (ctx) => {
      if (!this.isAllowedUser(ctx.from?.id)) return
      const frontend = await this.ensureFrontend(ctx)
      if (!frontend) return

      // 不 await — 让 prompt 后台运行，避免阻塞 polling 循环（否则收不到 callback_query）
      this.runWithContext(bot, ctx, frontend, async () => {
        await chatGateway.prompt(frontend.sessionId, ctx.message.text)
      }).catch((err) => {
        log.error(`prompt 失败: ${err}`)
      })
    })

    // ─── 图片消息 → prompt（附带图片） ──────────

    bot.on('message:photo', async (ctx) => {
      if (!this.isAllowedUser(ctx.from?.id)) return
      const frontend = await this.ensureFrontend(ctx)
      if (!frontend) return

      try {
        // 下载最大尺寸的图片
        const photos = ctx.message.photo
        const largest = photos[photos.length - 1]
        const file = await bot.api.getFile(largest.file_id)
        const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`
        const response = await fetch(fileUrl)
        const buffer = Buffer.from(await response.arrayBuffer())

        // 从文件扩展名推断原始 MIME 类型
        const ext = file.file_path?.split('.').pop()?.toLowerCase() || 'jpg'
        const mimeMap: Record<string, string> = {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          webp: 'image/webp'
        }
        const originalMime = mimeMap[ext] || 'image/jpeg'

        // 压缩处理（与桌面端一致：大图缩小到 2048px + JPEG 85%）
        const compressed = compressImageBuffer(buffer, originalMime)
        const caption = ctx.message.caption || '[Image]'

        // 不 await — 同文本消息，避免阻塞 polling 循环
        this.runWithContext(bot, ctx, frontend, async () => {
          await chatGateway.prompt(frontend.sessionId, caption, [
            { type: 'image', data: compressed.data, mimeType: compressed.mimeType }
          ])
        }).catch((err) => {
          log.error(`prompt 失败: ${err}`)
        })
      } catch (err) {
        log.error(`图片处理失败: ${err}`)
        await ctx.reply('Failed to process image.').catch(() => {})
      }
    })

    // ─── 回调查询（Inline Keyboard 点击） ────────

    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      // 格式: type:toolCallId:action — toolCallId 可能包含冒号，用首尾定位
      const firstColon = data.indexOf(':')
      const lastColon = data.lastIndexOf(':')
      if (firstColon === -1 || lastColon === firstColon) {
        await ctx.answerCallbackQuery()
        return
      }
      const type = data.slice(0, firstColon)
      const toolCallId = data.slice(firstColon + 1, lastColon)
      const action = data.slice(lastColon + 1)

      try {
        if (type === 'approve') {
          const approved = action === 'yes'
          log.info(`审批回调: toolCallId=${toolCallId}, approved=${approved}`)
          chatGateway.approveToolCall(
            toolCallId,
            approved,
            approved ? undefined : 'Denied via Telegram'
          )
          await ctx.answerCallbackQuery({ text: approved ? 'Approved' : 'Denied' })
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
        } else if (type === 'ask') {
          if (action === 'done') {
            // 多选提交
            const frontend = this.findFrontendByChat(ctx.callbackQuery.message?.chat.id)
            if (frontend) {
              const indices = frontend.getAskSelections(toolCallId)
              chatGateway.respondToAsk(
                toolCallId,
                indices.map((i) => String(i))
              )
            }
            await ctx.answerCallbackQuery({ text: 'Submitted' })
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
          } else {
            // 单选直接提交 / 多选切换
            const index = parseInt(action)
            if (isNaN(index)) {
              await ctx.answerCallbackQuery()
              return
            }

            const frontend = this.findFrontendByChat(ctx.callbackQuery.message?.chat.id)
            if (!frontend) {
              await ctx.answerCallbackQuery()
              return
            }

            // 检查是否是多选模式（有 done 按钮说明是多选）
            const hasSubmitBtn = ctx.callbackQuery.message?.reply_markup?.inline_keyboard?.some(
              (row) =>
                row.some((btn) => 'callback_data' in btn && btn.callback_data?.endsWith(':done'))
            )

            if (hasSubmitBtn) {
              // 多选模式：切换选项
              frontend.toggleAskSelection(toolCallId, index)
              await ctx.answerCallbackQuery({ text: `Toggled option ${index + 1}` })
            } else {
              // 单选模式：直接提交
              chatGateway.respondToAsk(toolCallId, [String(index)])
              await ctx.answerCallbackQuery({ text: 'Selected' })
              await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
            }
          }
        } else {
          await ctx.answerCallbackQuery()
        }
      } catch (err) {
        log.error(`回调处理失败: ${err}`)
        await ctx.answerCallbackQuery({ text: 'Error' }).catch(() => {})
      }
    })

    // ─── 错误处理 ────────────────────────────────

    bot.catch((err) => {
      log.error(`Bot 错误: ${err.message}`)
    })

    // ─── 启动 long polling ────────────────────────

    log.info('启动 Telegram Bot...')

    // 显式删除可能残留的 webhook（webhook 存在时 long polling 收不到 callback_query）
    await bot.api.deleteWebhook().catch((err) => {
      log.warn(`删除 webhook 失败: ${err}`)
    })

    bot
      .start({
        allowed_updates: ['message', 'callback_query'],
        onStart: (botInfo) => {
          log.info(`Telegram Bot 已启动: @${botInfo.username} (id=${botInfo.id})`)
        }
      })
      .catch((err) => {
        log.error(`Bot 启动失败: ${err}`)
        this.bot = null
      })
  }

  /** 停止 Bot */
  async stop(): Promise<void> {
    if (!this.bot) return
    // 清理所有 frontend 绑定
    for (const frontend of this.activeFrontends.values()) {
      chatFrontendRegistry.unbind(frontend.sessionId, frontend.id)
      frontend.destroy()
    }
    this.activeFrontends.clear()
    await this.bot.stop()
    this.bot = null
    log.info('Telegram Bot 已停止')
  }

  isRunning(): boolean {
    return this.bot !== null
  }

  /** 当 session 被取消共享时，解绑所有关联的 frontend */
  unbindSession(sessionId: string): void {
    for (const [chatId, frontend] of this.activeFrontends) {
      if (frontend.sessionId === sessionId) {
        chatFrontendRegistry.unbind(sessionId, frontend.id)
        frontend.destroy()
        this.activeFrontends.delete(chatId)
        log.info(`解绑 chat=${chatId}（session 取消共享）`)
        // 通知 Telegram 用户
        this.bot?.api
          .sendMessage(chatId, 'Session unshared. Send a message to reconnect.')
          .catch(() => {})
      }
    }
  }

  // ─── 内部方法 ──────────────────────────────────

  private isAllowedUser(userId: number | undefined): boolean {
    if (!userId) return false
    return telegramService.isAllowedUser(userId)
  }

  /** 确保 chat 已绑定 frontend，未绑定时自动接入第一个共享 session */
  private async ensureFrontend(ctx: Context): Promise<TelegramFrontend | null> {
    const chatId = ctx.chat!.id
    const existing = this.activeFrontends.get(chatId)
    if (existing) return existing

    const shared = telegramService.listShared()
    if (shared.length === 0) {
      await ctx.reply('No shared sessions. Enable Telegram sharing in ShuviX.')
      return null
    }
    this.bindChat(chatId, shared[0], ctx.from!.id)
    return this.activeFrontends.get(chatId)!
  }

  /** 在 OperationContext 中执行 chatGateway 操作 */
  private async runWithContext(
    bot: Bot,
    ctx: Context,
    frontend: TelegramFrontend,
    fn: () => Promise<void>
  ): Promise<void> {
    const opCtx = createTelegramContext(
      bot.botInfo.id.toString(),
      ctx.from!.id.toString(),
      ctx.chat!.id.toString(),
      frontend.sessionId
    )
    await operationContext.run(opCtx, async () => {
      chatGateway.startChat(frontend.sessionId)
      await fn()
    })
  }

  private bindChat(chatId: number, sessionId: string, userId: number): void {
    this.unbindChat(chatId)
    const frontend = new TelegramFrontend(this.bot!, chatId, sessionId, userId)
    this.activeFrontends.set(chatId, frontend)
    chatFrontendRegistry.bind(sessionId, frontend)
    log.info(`绑定 chat=${chatId} → session=${sessionId.slice(0, 8)}`)
  }

  private unbindChat(chatId: number): void {
    const frontend = this.activeFrontends.get(chatId)
    if (frontend) {
      chatFrontendRegistry.unbind(frontend.sessionId, frontend.id)
      frontend.destroy()
      this.activeFrontends.delete(chatId)
      log.info(`解绑 chat=${chatId}`)
    }
  }

  private findFrontendByChat(chatId: number | undefined): TelegramFrontend | undefined {
    if (!chatId) return undefined
    return this.activeFrontends.get(chatId)
  }
}

/** 全局单例 */
export const telegramBotServer = new TelegramBotServer()
// 注册到 telegramService，打破循环依赖
telegramService.registerServer(telegramBotServer)
