/**
 * chord `Context` 的小工具。durable 的每个异步调用都要一个 Context（携带取消）：
 * 会话运行时自己发起的调用一律用不可取消的后台 Context —— 取消一次「等待」只取消等待本身，
 * 从不取消已经提交的工作（durable 的语义），所以没有理由在这里传播调用方的 signal。
 */
import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'

/** 永不取消的后台 Context */
export const backgroundContext: Context = BACKGROUND_CONTEXT

/**
 * 关停后的错误：durable 的 Harness / Session 关停后一律以这两种文案拒绝；存储报错让会话失败之后
 * （pi-durable 1.2 起读写都会），之后的每个调用以 `SessionFailed` 拒绝 —— 同样当关停处理
 */
export function isClosedError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'SessionFailed') return true
  const message = error instanceof Error ? error.message : String(error)
  return message === 'Harness is closed' || message === 'Session is closed'
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
