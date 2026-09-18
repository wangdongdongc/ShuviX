/**
 * MCP 设置页列表的两个纯判断 —— 与组件分开，好让它们能被单独钉住。
 *
 * （组件文件一导入就要 `window`，node 环境下的单测进不去；这两个函数又恰恰是最容易
 * 「看起来对」地错掉的地方，所以拎出来。）
 */

/**
 * env JSON 里声明的 key 是否**都填了值**。
 *
 * **一个 key 都没声明 = 无需配置**，所以答 true（空集上的全称命题）。这一条不是细节：
 * `inproc` 内置能力服务器不起进程也不连网络，env 恒为 `{}` —— 读成 false 会让
 * 「请配置所需 API Key」那句提示永远亮在一台根本没有 key 可填的服务器下面。
 *
 * 解析不了才是真的「不知道填没填」，那一支保持 false（提示照出，让人去看配置）。
 */
export function envHasAllValues(envJson: string): boolean {
  try {
    const obj = JSON.parse(envJson || '{}') as Record<string, string>
    return Object.entries(obj).every(([, v]) => typeof v === 'string' && v.trim().length > 0)
  } catch {
    return false
  }
}

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
