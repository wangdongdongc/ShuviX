/**
 * agent 调组件操作的共用部分：组件的 MCP 服务器（真调用）和 `widget` 工具的 `test`（回滚）走同一段，
 * 找操作、报错的说法和结果的文字才不会分叉。
 */
import { callWidgetOp, readApiSnapshot, WidgetApiError, widgetStorageOf } from './api/widgetApi'
import type { WidgetCaller } from './api/hostProtocol'
import type { OpManifest } from './api/sandboxRuntime'

/** 这个组件能给 agent 调的操作定义。`screenOnly`：纯界面的操作也算（只有造组件时的测试） */
export function resolveAgentOp(
  widgetId: string,
  opName: string,
  options: { screenOnly?: boolean } = {}
): OpManifest {
  const snapshot = widgetStorageOf(widgetId) === 'sqlite' ? readApiSnapshot(widgetId) : null
  if (!snapshot) {
    throw new Error(`Widget "${widgetId}" has no API, so it has no operations to call.`)
  }
  const visible = snapshot.ops.filter((op) => op.agent !== false || options.screenOnly === true)
  const entry = visible.find((op) => op.name === opName)
  if (!entry) {
    const names = visible.map((op) => op.name).join(', ')
    throw new Error(`Widget "${widgetId}" has no operation "${opName}". Its operations: ${names}.`)
  }
  return entry
}

/**
 * 跑一个操作，交回给模型看的文字。`isError` 是这次调用失败了（参数不对、`ctx.fail`、handler 出错、宿主报错）；
 * 其余异常照常抛。
 */
export async function runWidgetOpForAgent(
  widgetId: string,
  entry: OpManifest,
  args: unknown,
  caller: WidgetCaller,
  options: { dryRun?: boolean } = {}
): Promise<{ text: string; isError: boolean }> {
  const dryRun = options.dryRun === true
  let outcome
  let logs: string[]
  try {
    const { result } = await callWidgetOp(widgetId, entry.name, args, caller, {
      dryRun,
      allowUiOnly: dryRun,
      // 授权按这次读到的读 / 写判的：其间有人重新构建、把它改成了写操作，分发器拒绝而不是照跑
      expectedMode: entry.mode
    })
    outcome = result.outcome
    logs = result.logs
  } catch (e) {
    if (e instanceof WidgetApiError) return { text: `[${e.code}] ${e.message}`, isError: true }
    throw e
  }
  const tail = [
    dryRun ? '(dry run: everything it wrote was rolled back)' : '',
    logs.length > 0 ? `<logs>\n${logs.join('\n')}\n</logs>` : ''
  ].filter(Boolean)
  if (!outcome.ok) {
    const { code, message } = outcome.error
    // 参数不对：附上这个操作的 input schema
    const schema = code === 'invalid_args' ? `\nInput schema: ${JSON.stringify(entry.input)}` : ''
    // handler 意外抛错（不是 ctx.fail 的业务失败）：说清楚是组件的代码出了错
    const head =
      code === 'internal' ? `Widget operation failed: ${message}` : `[${code}] ${message}`
    return { text: [`${head}${schema}`, ...tail].join('\n'), isError: true }
  }
  const value = outcome.value === undefined ? 'null' : JSON.stringify(outcome.value, null, 2)
  return { text: [value, ...tail].join('\n'), isError: false }
}
