/**
 * Telegram API 速率限制器
 * Telegram 限制: ~30 msg/sec 全局, ~1 msg/sec 每个 chat（常规消息）
 * 采用保守的 100ms 最小间隔（10 msg/sec）
 */
export class TelegramRateLimiter {
  private queue: Array<() => Promise<void>> = []
  private processing = false
  private lastSendTime = 0
  private readonly minIntervalMs = 100

  async enqueue(fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await fn()
          resolve()
        } catch (err) {
          reject(err)
        }
      })
      void this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true
    while (this.queue.length > 0) {
      const now = Date.now()
      const elapsed = now - this.lastSendTime
      if (elapsed < this.minIntervalMs) {
        await new Promise<void>((r) => setTimeout(r, this.minIntervalMs - elapsed))
      }
      const fn = this.queue.shift()!
      this.lastSendTime = Date.now()
      await fn()
    }
    this.processing = false
  }
}
