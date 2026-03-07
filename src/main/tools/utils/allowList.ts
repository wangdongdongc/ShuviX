/**
 * 检查命令是否匹配允许列表。
 * - 精确匹配：`npm run test` 仅匹配 `npm run test`
 * - 前缀匹配：`npm run *` 匹配所有 `npm run ` 开头的命令
 */
export function isCommandAllowed(
  allowList: string[] | undefined,
  command: string
): boolean {
  if (!allowList || allowList.length === 0) return false
  const trimmed = command.trim()
  return allowList.some((pattern) => {
    const p = pattern.trim()
    if (p.endsWith('*')) {
      return trimmed.startsWith(p.slice(0, -1))
    }
    return trimmed === p
  })
}
