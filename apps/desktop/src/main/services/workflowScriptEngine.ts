/**
 * Workflow 脚本引擎（桌面过渡实现）—— node:vm 落地共享 seam WorkflowScriptEngine。
 *
 * 明确边界（docs/workflow-md-design.md §4.1）：node:vm **不是安全边界** —— 这里的
 * 威胁模型与 agent md 等价（workflow md 是用户本地配置，agent 要写它先过 ask-on-write
 * 门），vm 提供的是**故障隔离**：脚本只见注入 API（跨膜纯 JSON），拿不到 require/
 * process/宿主对象；`timeout` 只护住同步段，await 之后的同步死循环 node:vm 无法打断
 * （这正是目标态换 QuickJS wasm 的理由）—— 引擎侧的墙钟 deadline 保证 run 记录照常
 * 超时收尾。目标态：两端统一的 QuickJS（wasm 经宿主注入，先例 tree-sitter）。
 *
 * 执行语义：脚本包进 `(async () => { … })()` —— 顶层 await 与顶层 return 同时成立，
 * 返回值即 run 输出。
 */
import vm from 'node:vm'
import type { WorkflowScriptEngine } from '@shuvix/agent-runtime'

/** 同步段守卫（初始求值 + 每个同步续体不适用 —— 见文件头）；异步整体由引擎 deadline 管 */
const SYNC_TIMEOUT_MS = 10_000

function wrap(source: string): string {
  return `(async () => {\n${source}\n})()`
}

export const nodeVmScriptEngine: WorkflowScriptEngine = {
  compile(source) {
    try {
      // 仅语法检查（不执行）；包装后行号偏 1，错误消息原样回传已够定位
      new vm.Script(wrap(source), { filename: 'workflow-script' })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async execute(source, api, opts) {
    // 上下文只有注入 API；realm 自带的 JSON/Math/Promise 等原语在 vm 内可用
    const context = vm.createContext(Object.assign(Object.create(null), api))
    const script = new vm.Script(wrap(source), { filename: 'workflow-script' })
    const result: unknown = script.runInContext(context, { timeout: SYNC_TIMEOUT_MS })
    if (opts.signal.aborted) throw new Error('workflow run aborted')
    return await Promise.resolve(result)
  }
}
