/**
 * MCP 设置页里两个纯判断 —— 它们都曾以「看起来对」的方式错着。
 *
 * `envHasAllValues` 回答的是「这台服务器所需的 key 都填了吗」，从前把**一个 key 都没声明**
 * 当成没填好，于是 `inproc` 内置能力服务器（env 恒为 `{}`、不起进程也不连网络）下面永远挂着
 * 一句「请配置所需 API Key」，而那台服务器根本没有 key 可填。
 *
 * `sortServersForDisplay` 只管显示：内置的置顶。后端按 `createdAt` 返回，于是后种进来的内置
 * 能力服务器会掉到用户自己添加的服务器后面 —— 偏偏它默认关着、等人来勾，最该一眼看见。
 */
import { describe, expect, it } from 'vitest'
import { envHasAllValues, sortServersForDisplay } from './mcpServerList'

describe('envHasAllValues', () => {
  it('没声明任何 key = 无需配置 —— 这是 inproc 内置服务器的常态', () => {
    // 坏掉的样子：一句「请配置 API Key」恒亮在一台没有 key 可填的服务器下面
    expect(envHasAllValues('{}')).toBe(true)
    expect(envHasAllValues('')).toBe(true)
  })

  it('声明了就得填：空串与纯空白都算没填', () => {
    expect(envHasAllValues('{"TAVILY_API_KEY":""}')).toBe(false)
    expect(envHasAllValues('{"TAVILY_API_KEY":"   "}')).toBe(false)
  })

  it('填齐了才算齐 —— 少一个就不算', () => {
    expect(envHasAllValues('{"TAVILY_API_KEY":"sk-x"}')).toBe(true)
    expect(envHasAllValues('{"A":"v","B":"w"}')).toBe(true)
    expect(envHasAllValues('{"A":"v","B":""}')).toBe(false)
  })

  it('解析不了是「不知道填没填」，保持 false 让提示照出', () => {
    expect(envHasAllValues('not json')).toBe(false)
    // 值不是字符串同样按没填算（配置被外部写坏时不该假装没事）
    expect(envHasAllValues('{"A":123}')).toBe(false)
  })
})

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
    // 后端按 createdAt 升序；tavily(v10) 早于 ssh(v22)，用户的两台夹在中间
    const sorted = sortServersForDisplay([
      row('tavily', 1),
      row('user-early', 0),
      row('user-late', 0),
      row('ssh', 1)
    ])
    expect(sorted.map((s) => s.name)).toEqual(['tavily', 'ssh', 'user-early', 'user-late'])
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
