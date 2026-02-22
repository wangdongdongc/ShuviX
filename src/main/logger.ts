import log from 'electron-log/main'

// 日志文件轮转：单文件 5MB
log.transports.file.maxSize = 5 * 1024 * 1024

// 日志格式
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}'
log.transports.console.format = '[{h}:{i}:{s}] [{level}]{scope} {text}'

// 生产环境控制台只输出 warn 及以上
if (process.env.NODE_ENV === 'production') {
  log.transports.console.level = 'warn'
}

/** 创建带模块标签的 logger（使用 electron-log scope） */
export function createLogger(tag: string): ReturnType<typeof log.scope> {
  return log.scope(tag)
}

export default log
