/**
 * PhasePendingError —— pi-durable 迁移期间「这条路径暂时没有实现」的统一标记。
 *
 * P1-01（原子切换）把 pi 0.80 的 agent 运行时整个删掉之后，会话运行时由 phase 1 重建，派生 agent 与
 * 界面投影留给后面的阶段；仍被调用到的未实现入口一律抛这个错误，而不是悄悄返回空值 —— 调用方
 *（与日志）能一眼看出是「迁移未完成」而不是真故障。每个抛出点旁边都带一个可 grep 的
 * `TODO(pi-durable p<N>)` 标签，写明由哪个阶段接手（迁移完成之后再议的事项标 `p5`）。
 *
 * `phase`：3 = 投影 / UI。phase 1 已经完成（P1-13），phase 2（派生 agent / 子会话）也已完成（P2-13），
 * 类型里不再收 1 与 2 —— 新代码不该再留一条「本阶段之后补」的路径。
 */
export class PhasePendingError extends Error {
  readonly feature: string
  readonly phase: 3

  constructor(feature: string, phase: 3) {
    super(`${feature} is not available yet (pi-durable migration, phase ${phase})`)
    this.name = 'PhasePendingError'
    this.feature = feature
    this.phase = phase
  }
}

export function isPhasePendingError(err: unknown): err is PhasePendingError {
  return err instanceof PhasePendingError
}
