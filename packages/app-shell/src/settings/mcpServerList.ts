/**
 * MCP 设置页列表的显示顺序 —— 与组件分开，好让它能被单独钉住
 * （组件文件一导入就要 `window`，node 环境下的单测进不去）。
 */

/**
 * 显示顺序：**内置服务器置顶**，其余保持后端给的顺序（`createdAt` 升序）。
 *
 * 内置的是「随产品发布、删不掉」的那一类，也是用户最可能要找的行 —— 能力服务器尤其如此，
 * 它默认关着、等人来勾。可它们按种进来的时间排，会掉到用户自己添加的服务器后面。
 *
 * 只动显示：后端仍按 `createdAt` 返回，工具装配也不看这里。排序是稳定的，所以组内次序不变。
 */
export function sortServersForDisplay<T extends { isBuiltin: number }>(servers: readonly T[]): T[] {
  return [...servers].sort((a, b) => b.isBuiltin - a.isBuiltin)
}
