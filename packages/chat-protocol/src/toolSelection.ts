/**
 * 会话的扩展能力勾选（`settings.enabledTools`，项目上的同名键是它新会话的缺省）—— 一份相对于
 * 会话 agent 档案的**增减**：
 *
 *  - `mcp:<server>` / `skill:<name>`：在档案之上加一项；
 *  - `-mcp:<server>` / `-skill:<name>`：取消档案 `shuvix-tools` 声明的一项，只对这条会话（或这个项目的
 *    新会话）。档案声明的项因此是**缺省勾上**，不是锁死 —— 例如一个会话改用别的作图技能时，可以把基座
 *    档案带的 `skill:builtin:drawing` 取消掉，免得两份作图规矩同时在场。
 *
 * 为什么是同一份列表里的记号、而不是另开一个字段：勾选的整套生命周期 —— 项目缺省、子会话抄父会话、
 * 欢迎页草稿、agent 在时只读、锁着时按锁报 —— 对「加」和「减」一模一样，两份列表只会在某一处被漏掉。
 * 取消记号只对档案声明了的项有意义；写着一个档案没声明的项的取消记号，什么也不做。
 *
 * 运行时一侧的归一在 agent-runtime 的 `normalizeToolNames`；界面一侧（工具选择器、会话设置、项目设置）
 * 用这里的 `isToolSelected` / `setToolSelected` 读写，两边按同一个记号说话。
 */

/** 取消记号的前缀 */
export const TOOL_OPT_OUT_PREFIX = '-'

/** 会话能勾选的那两类（MCP 服务器 / 技能）；内置工具名恒由档案决定，不在勾选里 */
export function isSessionScopedToolName(name: string): boolean {
  return name.startsWith('mcp:') || name.startsWith('skill:')
}

/** 这一条是不是取消记号（`-mcp:…` / `-skill:…`） */
export function isToolOptOut(entry: string): boolean {
  return (
    entry.startsWith(TOOL_OPT_OUT_PREFIX) &&
    isSessionScopedToolName(entry.slice(TOOL_OPT_OUT_PREFIX.length))
  )
}

/** 取消某一项的记号 */
export function toolOptOut(name: string): string {
  return `${TOOL_OPT_OUT_PREFIX}${name}`
}

/** 勾选里能出现的条目：加的一项，或取消记号 —— 写入口据此过滤掉别的东西 */
export function isToolSelectionEntry(entry: string): boolean {
  return isSessionScopedToolName(entry) || isToolOptOut(entry)
}

/** 勾选里被取消的那些项（去掉记号之后的名字） */
export function optedOutTools(selection: readonly string[]): Set<string> {
  return new Set(
    selection.filter(isToolOptOut).map((entry) => entry.slice(TOOL_OPT_OUT_PREFIX.length))
  )
}

/**
 * 某一项此刻开没开：档案声明的项看有没有被取消，其余看有没有被勾上。
 * 两个记号同时在时取消赢（与 `normalizeToolNames` 同一口径）。
 */
export function isToolSelected(
  selection: readonly string[],
  name: string,
  declared: boolean
): boolean {
  if (selection.includes(toolOptOut(name))) return false
  return declared || selection.includes(name)
}

/**
 * 把某一项设成开 / 关，返回新的整份勾选（写回是整份替换）。先抹掉这一项的两种记号，再按需要写一个：
 * 档案声明的项关掉时写取消记号、打开时什么都不写（缺省就是开着）；其余项打开时写它的名字。
 */
export function setToolSelected(
  selection: readonly string[],
  name: string,
  declared: boolean,
  on: boolean
): string[] {
  const rest = selection.filter((entry) => entry !== name && entry !== toolOptOut(name))
  if (declared) return on ? rest : [...rest, toolOptOut(name)]
  return on ? [...rest, name] : rest
}

/**
 * 确保这几项都开着（斜杠命令勾上它依赖的扩展能力用）：被取消的撤掉取消记号，没勾的勾上。
 * 不知道哪些是档案声明的，所以一律写名字 —— 对声明项多写一个名字只是冗余，开着的结果不变。
 */
export function withToolsSelected(
  selection: readonly string[],
  names: readonly string[]
): string[] {
  const wanted = new Set(names)
  const kept = selection.filter(
    (entry) => !(isToolOptOut(entry) && wanted.has(entry.slice(TOOL_OPT_OUT_PREFIX.length)))
  )
  return [...kept, ...[...wanted].filter((name) => !kept.includes(name))]
}
