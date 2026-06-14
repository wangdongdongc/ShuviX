/**
 * Bundler 模块内部类型
 */

/** 结构化日志接口（与主进程 createLogger 返回值兼容） */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}
