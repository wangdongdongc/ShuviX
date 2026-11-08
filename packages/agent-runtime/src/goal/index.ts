/**
 * 目标模式（docs/goal-mode-design.md）：状态机、写给模型的文字、会话目标的读写。宿主（桌面 goalService）把它们
 * 接到运行结束、判定型埋点 `goal.check` 与自动续跑上。
 */
export * from './goalState'
export * from './goalNotices'
export * from './goalStore'
