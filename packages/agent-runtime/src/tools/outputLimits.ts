/**
 * durable `outputLimits` 的兜底值 —— 由工具自己的截断声明（outputStrategy / outputMax*）推出。
 *
 * ShuviX 的截断 / 落盘由宿主包装器做（桌面 wrapToolOutput → processToolOutput），按工具声明的
 * 上限截每一个文本块，并在前面加两三行表头（`[Output truncated: …]`、落盘路径）。pi-durable 在
 * 那之后**再**按 `outputLimits` 把结果里所有文本拼起来截一次（缺省 50 KB / 2000 行），超了就再加
 * 一条 `<harness>` 截断诊断 —— 若两边上限相同，宿主截好的、带表头的输出会被 durable 又截掉
 * 末尾几行。所以 durable 这一道只当兜底：上限取工具上限的两倍（多个文本块各自截到上限、
 * 加上表头，也不至于碰到它），只防真正失控的输出。
 *
 * 保留哪一端跟着工具的策略走：`keep-end` → 留尾；`keep-start` 与 `middle` → 留头（durable
 * 没有「留首尾」；留头至少保住宿主表头里的落盘路径）。
 */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '../fileTools/truncate'
import type { TruncateStrategy } from '../toolOutput/spill'

/** durable `ToolRegistration.outputLimits` 的形状 */
export interface DurableOutputLimits {
  readonly maxBytes: number
  readonly maxLines: number
  readonly retain: 'head' | 'tail'
}

/** 工具身上可读的截断声明（BaseTool 的字段；旧形状工具上可能一个都没有） */
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
