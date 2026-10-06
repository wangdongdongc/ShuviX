/**
 * durable `outputLimits` 的兜底值 —— 由工具自己的截断声明（outputStrategy / outputMax*）推出。
 *
 * ShuviX 的截断 / 落盘由宿主包装器做（桌面 wrapDurableTool → processToolOutput），按工具声明的
 * 上限截每一个文本块：落盘时正文只留预览（≤ 200 行 / 10 KB），否则截到工具上限；表头与落盘路径
 * 不进正文，作为 diagnostic 交回（P1-06）。pi-durable 在那之后**再**按 `outputLimits` 把结果里
 * 所有文本拼起来截一次（缺省 50 KB / 2000 行），超了就再加一条 `<harness>` 截断诊断 —— 工具上限
 * 高于 durable 缺省时（read 的 80 KB），宿主截好的正文会被 durable 又截一刀。所以 durable 这一道
 * 只当兜底：上限取工具上限的两倍（一个文本块截完恰在上限之内，两个也碰不到它），只防真正失控的
 * 输出（好几段超长文本、或没经宿主包装的注册项）。包装器按自己实际用的上限再算一份，盖在包装后的
 * 注册项上（BaseTool 的 getter 与函数式注册项的字段一并遮住）。
 *
 * 保留哪一端跟着工具的策略走：`keep-end` → 留尾；`keep-start` 与 `middle` → 留头（durable
 * 没有「留首尾」）。经 `api.output()` 汇报、不给 content 的工具，durable 留存的输出也按这份上限截。
 */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '../fileTools/truncate'
import type { TruncateStrategy } from '../toolOutput/spill'

/** durable `ToolRegistration.outputLimits` 的形状 */
export interface DurableOutputLimits {
  readonly maxBytes: number
  readonly maxLines: number
  readonly retain: 'head' | 'tail'
}

/** 工具身上可读的截断声明（BaseTool 的字段；函数式注册项上可能一个都没有） */
export interface OutputDeclaration {
  readonly outputStrategy?: TruncateStrategy
  readonly outputMaxBytes?: number
  readonly outputMaxLines?: number
}

/** 兜底上限相对工具上限的倍数 */
export const OUTPUT_BACKSTOP_FACTOR = 2

export function backstopOutputLimits(decl: OutputDeclaration): DurableOutputLimits {
  return {
    maxBytes: (decl.outputMaxBytes ?? DEFAULT_MAX_BYTES) * OUTPUT_BACKSTOP_FACTOR,
    maxLines: (decl.outputMaxLines ?? DEFAULT_MAX_LINES) * OUTPUT_BACKSTOP_FACTOR,
    retain: decl.outputStrategy === 'keep-end' ? 'tail' : 'head'
  }
}
