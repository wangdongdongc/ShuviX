/**
 * 浏览器操作审批门控 —— mutating 操作的逐次 Allow/Deny（两端共享）。
 *
 * autoApprove 开 → 放行；关 → 经 requestUserInput 弹审批（复用现成 kind:'approval' 表单）：
 *   - 允许 → 放行（返回 null）；
 *   - 拒绝 → 返回「已拒绝」结果文案（agent 可据此改道，不视为崩溃）；
 *   - other（用户改为提交自由文本反馈）→ 不执行操作，把反馈作为工具结果返回；
 *   - cancel（agent.abort）→ 抛 abortError 终止本轮。
 */
import type { BrowserApprovalDeps, BrowserOpOutput } from './backend'
import type { BrowserAction, BrowserOpSpec } from './ops'

/** 把某次操作渲染成审批面板里展示的命令文本 */
export function describeBrowserOp(action: BrowserAction, params: Record<string, unknown>): string {
  const tabId = params.tabId
  const clip = (v: unknown, max: number): string => {
    const s = String(v ?? '')
    return s.length > max ? `${s.slice(0, max)}…` : s
  }
  switch (action) {
    case 'click':
      return `click(tab ${tabId}, element ${String(params.uid)})`
    case 'fill':
      return `fill(tab ${tabId}, element ${String(params.uid)}, text: ${JSON.stringify(clip(params.text, 80))})`
    case 'type': {
      const suffix = params.submitKey ? `, then ${String(params.submitKey)}` : ''
      return `type(tab ${tabId}, text: ${JSON.stringify(clip(params.text, 80))}${suffix})`
    }
    case 'press_key':
      return `press_key(tab ${tabId}, ${String(params.key)})`
    case 'navigate': {
      const nav = (params.nav as string) || 'goto'
      return nav === 'goto'
        ? `navigate(tab ${tabId} → ${String(params.url)})`
        : `navigate(tab ${tabId}, ${nav})`
    }
    case 'evaluate':
      return `evaluate(tab ${tabId}, ${clip(params.expression, 120)})`
    case 'close_tab':
      return `close_tab(tab ${tabId})`
    case 'cdp':
      return `cdp(tab ${tabId}, ${String(params.method)}${params.params ? ` ${clip(JSON.stringify(params.params), 120)}` : ''})`
    default:
      return `${action}(tab ${tabId})`
  }
}

/**
 * 对一次 mutating 操作执行审批。
 * 返回 null = 放行；返回 BrowserOpOutput = 不执行操作、把该结果回给 agent；cancel 抛 abortError。
 */
export async function gateBrowserOp(
  spec: BrowserOpSpec,
  params: Record<string, unknown>,
  deps: BrowserApprovalDeps,
  opts: { toolCallId: string; abortError: string }
): Promise<BrowserOpOutput | null> {
  if (deps.isAutoApprove()) return null

  const response = await deps.requestUserInput({
    id: opts.toolCallId,
    kind: 'approval',
    toolName: 'browser',
    command: describeBrowserOp(spec.name, params),
    createdAt: Date.now()
  })

  if (response.kind === 'cancel') throw new Error(opts.abortError)
  if (response.kind === 'other') {
    return {
      text: `User did not approve the browser operation and responded with feedback instead:\n${response.text}`,
      details: { error: 'not approved' }
    }
  }
  if (response.kind === 'approval' && response.approved) return null

  const reason =
    response.kind === 'approval' && response.reason ? ` Reason: ${response.reason}` : ''
  return {
    text: `User denied the browser operation "${spec.name}". Do not retry it; consider an alternative or ask the user.${reason}`,
    details: { error: 'denied' }
  }
}
