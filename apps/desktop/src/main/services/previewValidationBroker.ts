/**
 * preview 工具的图表渲染验证 broker（桌面）。
 *
 * 主进程无 DOM，mermaid 成败只有渲染端知道 —— 这里经 AppEvent 'preview.validateChart'
 * 请任意渲染窗口用与 ChartView 同一管线（renderMermaid）验证，渲染端经 IPC
 * 'preview:reportRender' 回执，按 validationId 对号入座（多窗口先到先得）。
 * 超时（无渲染窗口，如纯 Telegram 会话 / 窗口全关）诚实降级：按成功放行但 verified=false，
 * 工具结果注明「渲染未验证」—— 永不悬死 agent 的工具调用。
 */
import { randomUUID } from 'crypto'
import type { ChartValidation } from '@shuvix/agent-runtime'
import { appEventBus } from '../utils/appEventBus'

const TIMEOUT_MS = 4000

const pending = new Map<string, (result: ChartValidation) => void>()

/** 发起一次渲染端验证（preview 工具调用）；超时按未验证成功解析 */
export function validateChartViaRenderer(params: {
  sessionId: string
  absPath: string
}): Promise<ChartValidation> {
  return new Promise((resolve) => {
    const validationId = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(validationId)
      resolve({ ok: true, verified: false })
    }, TIMEOUT_MS)
    pending.set(validationId, (result) => {
      clearTimeout(timer)
      pending.delete(validationId)
      resolve(result)
    })
    appEventBus.publish({
      type: 'preview.validateChart',
      validationId,
      sessionId: params.sessionId,
      absPath: params.absPath
    })
  })
}

/** 渲染端回执入口（IPC preview:reportRender）；未知/已解决的 id 返回 accepted:false（多窗口后到者） */
export function reportChartValidation(params: {
  validationId: string
  ok: boolean
  error?: string
}): { accepted: boolean } {
  const resolve = pending.get(params.validationId)
  if (!resolve) return { accepted: false }
  resolve({ ok: params.ok, error: params.error, verified: true })
  return { accepted: true }
}
