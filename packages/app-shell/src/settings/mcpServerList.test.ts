/**
 * `sortServersForDisplay` 只管显示：内置的置顶。后端按 `createdAt` 返回，于是后种进来的内置
 * 能力服务器会掉到用户自己添加的服务器后面 —— 偏偏它默认关着、等人来勾，最该一眼看见。
 *
 * （同一个文件里曾有 `envHasAllValues`，为「这台服务器所需的 key 都填了吗」服务。内置 server
 * 从此恒为 `inproc`、没有 env 可填，那句提示再也点不亮，随 v24 一并拆掉。）
 */
import { describe, expect, it } from 'vitest'
import { sortServersForDisplay } from './mcpServerList'

describe('sortServersForDisplay', () => {
  const row = (name: string, isBuiltin: number): { name: string; isBuiltin: number } => ({
    name,
    isBuiltin
  })

  it('内置置顶', () => {
    const sorted = sortServersForDisplay([row('user-a', 0), row('ssh', 1), row('user-b', 0)])
    expect(sorted.map((s) => s.name)).toEqual(['ssh', 'user-a', 'user-b'])
  })

  it('组内保持后端给的顺序（稳定排序）', () => {
    // 后端按 createdAt 升序；用户的两台夹在两台内置之间
    const sorted = sortServersForDisplay([
      row('builtin-old', 1),
      row('user-early', 0),
      row('user-late', 0),
      row('ssh', 1)
    ])
    expect(sorted.map((s) => s.name)).toEqual(['builtin-old', 'ssh', 'user-early', 'user-late'])
  })

  it('全内置 / 全用户 / 空列表都原样', () => {
    expect(sortServersForDisplay([row('a', 1), row('b', 1)]).map((s) => s.name)).toEqual(['a', 'b'])
    expect(sortServersForDisplay([row('a', 0), row('b', 0)]).map((s) => s.name)).toEqual(['a', 'b'])
    expect(sortServersForDisplay([])).toEqual([])
  })

  it('不改动入参 —— 调用方拿到的是后端那份快照', () => {
    const input = [row('user', 0), row('ssh', 1)]
    const sorted = sortServersForDisplay(input)
    expect(input.map((s) => s.name)).toEqual(['user', 'ssh'])
    expect(sorted).not.toBe(input)
  })
})
