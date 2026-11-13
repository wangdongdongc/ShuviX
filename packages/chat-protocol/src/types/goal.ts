/**
 * 目标（`/goal`，docs/goal-mode-design.md §16，实验）的共享类型。
 *
 * 用户在一条会话的输入框里写 `/goal <条件>`：宿主把这条会话 fork 一份，fork 出来的那条是这个目标的**管理员**，
 * 原会话接着干活。管理员是一条普通会话 —— 它带着设目标之前的全部对话，把目标整理成验收条件、问用户、把任务发给
 * 原会话、按原会话的汇报验收、向用户汇报；用户随时在管理员会话里说话来调整目标、了解进展。宿主不再有目标记录、
 * 检查员、续跑轮次与上限（2026-11-12 用户裁决：规划与检验要看得见、插得上话，轮次交给管理员动态决定）。
 */

/** 目标条件的长度上限（与 Claude Code / Codex 相同） */
export const GOAL_OBJECTIVE_MAX_CHARS = 4000

/** 设定目标的结果：成了 → 管理员会话的 id（界面切过去）；被拒 → 给人读的一句话 */
export type GoalStartResult = { ok: true; sessionId: string } | { ok: false; error: string }
