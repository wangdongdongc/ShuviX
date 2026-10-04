/**
 * PhasePendingError —— pi-durable 迁移期间「这条路径暂时没有实现」的统一标记。
 *
 * P1-01（原子切换）把 pi 0.80 的 agent 运行时整个删掉之后，会话运行时要等 P1-02…P1-11 逐步重建；
 * 期间仍被调用到的入口一律抛这个错误，而不是悄悄返回空值 —— 调用方（与日志）能一眼
 * 看出是「迁移未完成」而不是真故障。每个抛出点旁边都带一个可 grep 的
 * `TODO(pi-durable p1|p2|p3)` 标签，写明由哪个任务接手。
 *
 * `phase`：1 = 本阶段内的后续任务（P1-0x），2 = 派生 agent，3 = 投影 / UI。
 */
export class PhasePendingError extends Error {
  readonly feature: string
  readonly phase: 1 | 2 | 3

  constructor(feature: string, phase: 1 | 2 | 3) {
    super(`${feature} is not available yet (pi-durable migration, phase ${phase})`)
    this.name = 'PhasePendingError'
    this.feature = feature
    this.phase = phase
  }
}

export function isPhasePendingError(err: unknown): err is PhasePendingError {
  return err instanceof PhasePendingError
}
