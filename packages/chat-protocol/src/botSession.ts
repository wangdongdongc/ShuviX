/**
 * Bot 会话的形态判定 —— 两个宿主与渲染层共用的一份。
 *
 * 一条 bot 会话绑定**一个** bot（`settings.bot`，指向 `~/.shuvix/bots/<name>.md`），在创建那一刻
 * 定死，之后不可转回普通会话，也不可换绑 —— 换一个 bot 就是另开一条会话，因为这条会话的全部
 * 历史都是那个 bot 说的话。
 *
 * **它是一条普通的有根会话**：根 Agent 的档案是基座 `bot`，人设与记忆经 systemContext 注入它的
 * 系统提示词。于是模型选择、工具勾选、压缩、导出、子会话、自动续跑 —— 会话该有的一切都天然
 * 成立，一行都不用为 bot 另写。
 *
 * 判定一律走这里，别在各处手写 `!!settings.bot`：空串 / 纯空白要算「没绑定」。
 */

/** 判定所需的最小字段（SessionSettings 是它的超集） */
export interface BotSessionShape {
  bot?: string
}

/** 绑定的 bot 名；不是 bot 会话则为 undefined */
export function boundBotOf(settings?: BotSessionShape | null): string | undefined {
  const bot = settings?.bot
  return typeof bot === 'string' && bot.trim() ? bot.trim() : undefined
}

/** 这是不是一条 bot 会话 */
export function isBotSessionSettings(settings?: BotSessionShape | null): boolean {
  return !!boundBotOf(settings)
}

// ─── 工作项目（bot 会话只归属 bot，项目只是它的工作位置） ─────────────────────────

/**
 * bot 会话**只归属于 bot**（2026-10-31）：它的 `projectId` 恒为空，侧栏与日历把它放在 bot 名下，项目的归档
 * 与删除都不碰它。选了项目当工作位置时，项目以**引用**记在 `settings.workProject`（项目 id），另记一份项目
 * 路径快照 `settings.workingDirectory` —— 项目被删时会话退回那个文件夹继续用。它的子会话与 fork 抄同一份引用。
 *
 * 「归属」与「用谁的项目设置」因此是两件事：
 *   - 归属（分组、归档隐藏、删除级联、按项目列会话）只看 `projectId`；
 *   - 项目设置（工作目录、项目知识库、项目提示词、环境变量、新建时的扩展默认）看 `projectContextIdOf` ——
 *     成员会话是所属项目，bot 会话（及其子会话）是引用的工作项目。
 */
export interface ProjectContextShape {
  projectId?: string | null
  settings?: { workProject?: string | null } | null
}

/** 会话引用的工作项目 id（`settings.workProject`）；没有则 undefined */
export function workProjectOf(
  settings?: { workProject?: string | null } | null
): string | undefined {
  const id = settings?.workProject
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

/** 这条会话用哪个项目的设置：所属项目，否则引用的工作项目；都没有 → null */
export function projectContextIdOf(row?: ProjectContextShape | null): string | null {
  if (!row) return null
  if (row.projectId) return row.projectId
  return workProjectOf(row.settings) ?? null
}
