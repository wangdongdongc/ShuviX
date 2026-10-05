/**
 * 落盘口（PIN-2 / P1-06b）：`wrapDurableOutput(tool, { spill: 'auto', sink })` 的 sink 写进世界级的 MemFs，
 * 位置 `/tool_results/<会话>/<spillId>.txt` —— 真 read 工具读得回来（在 /fake-home 之外，读不问）。
 * locator 就是那条路径；它出现在 `<harness>` 的 `[info]` 行与 `data.diagnostics`（code spilled），不进正文。
 */
import type { SpillSink } from '../../../../toolOutput/spill'
import type { MemFs } from './memFs'

export const TOOL_RESULTS_ROOT = '/tool_results'

export interface SpillLog {
  /** sink.write 的调用：[spillId, 全文长度]（按顺序，跨会话） */
  readonly writes: [string, number][]
}

export function spillLog(): SpillLog {
  return { writes: [] }
}

export function spillPath(sessionId: string, spillId: string): string {
  return `${TOOL_RESULTS_ROOT}/${sessionId}/${spillId}.txt`
}

/** 绑在一条会话上的落盘口（会话归属由宿主绑，内核不知道） */
export function memorySink(fs: MemFs, sessionId: string, log: SpillLog): SpillSink {
  return {
    write: async (spillId, fullText) => {
      log.writes.push([spillId, fullText.length])
      const locator = spillPath(sessionId, spillId)
      // 直接放进表里：落盘不是工具的写入，不计进 MemFs 的写计数
      fs.files.set(locator, fullText)
      return { locator }
    }
  }
}
