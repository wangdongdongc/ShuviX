import log from 'electron-log/main'
import { getOperationContext } from './frontend/core/OperationContext'

// 日志文件轮转：单文件 5MB
log.transports.file.maxSize = 5 * 1024 * 1024

// 日志格式
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}'
log.transports.console.format = '[{h}:{i}:{s}] [{level}]{scope} {text}'

// 生产环境控制台只输出 warn 及以上
if (process.env.NODE_ENV === 'production') {
  log.transports.console.level = 'warn'
}

// 自动注入 OperationContext 前缀（requestId:source）
log.hooks.push((message) => {
  const ctx = getOperationContext()
  if (ctx && message.data?.length > 0 && typeof message.data[0] === 'string') {
    const rid = ctx.requestId.slice(0, 8)
    const src = ctx.source.type
    message.data[0] = `[${rid}:${src}] ${message.data[0]}`
  }
  return message
})

/** 创建带模块标签的 logger（使用 electron-log scope） */
export function createLogger(tag: string): ReturnType<typeof log.scope> {
  return log.scope(tag)
}

export default log
