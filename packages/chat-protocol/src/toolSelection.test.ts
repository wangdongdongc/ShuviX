/**
 * 扩展能力勾选的记号 —— `toolSelection.ts`。
 *
 * 勾选（`settings.enabledTools`，项目上同名键是新会话的缺省）是相对于会话 agent 档案的**增减**，只管
 * MCP 服务器：`mcp:<server>` 加一台，`-mcp:<server>` 取消档案 `shuvix-tools` 声明的一台。技能不在勾选里
 * （2026-10-28：启用着的全部上货架），`skill:` / `-skill:` 不再是勾选条目。界面（工具选择器 / 会话设置 /
 * 项目设置）与写入口都按这里的函数说话，运行时一侧的 `normalizeToolNames` 与它同一口径（两个记号同时在时
 * 取消赢）。
 */
import { describe, expect, it } from 'vitest'
import {
  isToolOptOut,
  isToolSelected,
  isToolSelectionEntry,
  optedOutTools,
  setToolSelected,
  toolOptOut,
  withToolsSelected
} from './toolSelection'

describe('记号分类', () => {
  it('TS-1 isToolOptOut / isToolSelectionEntry / toolOptOut', () => {
    // 取消记号只对 MCP 服务器成立：内置名（-read / -agent）、技能（-skill:…，2026-10-28 起不再按会话勾选）
    // 都不是记号，双减号、空记号、大小写不对也不算
    for (const entry of ['-mcp:a', '-mcp:x:y']) {
      expect(isToolOptOut(entry), entry).toBe(true)
    }
    for (const entry of [
      'mcp:a',
      '-read',
      '-agent',
      '-skill:x',
      '-skill:builtin:drawing',
      '--mcp:x',
      '-',
      '-MCP:a',
      'bash'
    ]) {
      expect(isToolOptOut(entry), entry).toBe(false)
    }

    for (const entry of ['mcp:a', '-mcp:a']) {
      expect(isToolSelectionEntry(entry), entry).toBe(true)
    }
    for (const entry of [
      'read',
      'bash',
      'skill',
      'skill:x',
      'skill:builtin:drawing',
      '-skill:x',
      '-read',
      '-agent',
      '--mcp:x',
      '-',
      '-MCP:a',
      'MCP:a'
    ]) {
      expect(isToolSelectionEntry(entry), entry).toBe(false)
    }

    expect(toolOptOut('mcp:x')).toBe('-mcp:x')
  })

  it('TS-2 optedOutTools：只收合法取消记号、去掉前缀、去重；-skill: 不算', () => {
    expect(
      optedOutTools(['mcp:a', '-mcp:b', '-mcp:c', '-read', '-mcp:b', '--mcp:d', '-skill:e'])
    ).toEqual(new Set(['mcp:b', 'mcp:c']))
  })
})

describe('isToolSelected —— 某一项此刻开没开', () => {
  const NAME = 'mcp:n'

  it.each<[string, string[], boolean, boolean]>([
    ['声明 · 缺省（没有任何记号）', [], true, true],
    ['声明 · 显式勾上', [NAME], true, true],
    ['声明 · 取消', [`-${NAME}`], true, false],
    ['声明 · 勾 + 取消', [NAME, `-${NAME}`], true, false],
    ['声明 · 取消 + 勾', [`-${NAME}`, NAME], true, false],
    ['未声明 · 缺省', [], false, false],
    ['未声明 · 勾上', [NAME], false, true],
    ['未声明 · 取消', [`-${NAME}`], false, false],
    ['未声明 · 勾 + 取消', [NAME, `-${NAME}`], false, false],
    ['未声明 · 取消 + 勾', [`-${NAME}`, NAME], false, false]
  ])('TS-3 %s', (_label, selection, declared, expected) => {
    expect(isToolSelected(selection, NAME, declared)).toBe(expected)
  })

  it('TS-3 别的项的取消记号对这一项没有影响', () => {
    // 旧会话里残留的 -skill:n 也不是这一台的取消记号
    expect(isToolSelected(['-mcp:other', '-mcp:nn', '-skill:n'], NAME, true)).toBe(true)
    expect(isToolSelected(['-mcp:other', NAME], NAME, false)).toBe(true)
  })
})

describe('setToolSelected —— 设成开 / 关，返回整份新勾选', () => {
  const NAME = 'mcp:n'
  const OPT = '-mcp:n'

  it('TS-4 声明项关掉：抹掉显式勾选，取消记号只追加一次', () => {
    expect(setToolSelected(['mcp:a', NAME, 'mcp:b'], NAME, true, false)).toEqual([
      'mcp:a',
      'mcp:b',
      OPT
    ])
    expect(setToolSelected(['mcp:a', OPT, 'mcp:b', OPT], NAME, true, false)).toEqual([
      'mcp:a',
      'mcp:b',
      OPT
    ])
  })

  it('TS-4 声明项打开：抹掉取消记号，不写名字（缺省就是开着）', () => {
    expect(setToolSelected(['mcp:a', OPT, 'mcp:b'], NAME, true, true)).toEqual(['mcp:a', 'mcp:b'])
    expect(setToolSelected(['mcp:a'], NAME, true, true)).toEqual(['mcp:a'])
  })

  it('TS-4 未声明项打开：名字只追加一次，顺手清掉残留的取消记号', () => {
    expect(setToolSelected(['mcp:a', OPT, NAME], NAME, false, true)).toEqual(['mcp:a', NAME])
    expect(setToolSelected(['mcp:a'], NAME, false, true)).toEqual(['mcp:a', NAME])
  })

  it('TS-4 未声明项关掉：两种记号都抹掉', () => {
    expect(setToolSelected([NAME, 'mcp:a', OPT], NAME, false, false)).toEqual(['mcp:a'])
  })

  it('TS-4 其余条目保持原顺序；传入的数组不被改动', () => {
    const input = Object.freeze(['-mcp:z', NAME, 'mcp:b', 'mcp:a', OPT]) as readonly string[]
    const snapshot = [...input]
    const out = setToolSelected(input, NAME, true, false)
    expect(out).toEqual(['-mcp:z', 'mcp:b', 'mcp:a', OPT])
    expect(input).toEqual(snapshot)
    expect(out).not.toBe(input)
  })

  /** 这一项可能处在的四种记号状态，外加别的条目夹在中间 */
  const STATES: Array<[string, string[]]> = [
    ['无记号', ['mcp:a']],
    ['勾上', ['mcp:a', NAME]],
    ['取消', [OPT, 'mcp:a']],
    ['勾 + 取消', [NAME, 'mcp:a', OPT]]
  ]

  for (const declared of [true, false]) {
    for (const on of [true, false]) {
      for (const [label, selection] of STATES) {
        it(`TS-4 性质：declared=${declared} on=${on} 自「${label}」—— 结果读回就是 on，且幂等`, () => {
          const once = setToolSelected(selection, NAME, declared, on)
          expect(isToolSelected(once, NAME, declared)).toBe(on)
          expect(setToolSelected(once, NAME, declared, on)).toEqual(once)
          // 别的条目一个不丢
          expect(once).toContain('mcp:a')
        })
      }
    }
  }
})

describe('withToolsSelected —— 确保这几项开着（斜杠命令用）', () => {
  it('TS-5 撤掉被点名项的取消记号、补上没勾的（去重、按点名顺序）、别的取消记号不动', () => {
    const input = ['-mcp:d', 'mcp:a', '-mcp:z']
    const snapshot = [...input]
    expect(withToolsSelected(input, ['mcp:d', 'mcp:n', 'mcp:a', 'mcp:n'])).toEqual([
      'mcp:a',
      '-mcp:z',
      'mcp:d',
      'mcp:n'
    ])
    expect(input).toEqual(snapshot)
  })

  it('TS-5 什么都不缺：结果逐项等于输入', () => {
    const input = ['mcp:a', '-mcp:z', 'mcp:n']
    const out = withToolsSelected(input, ['mcp:n', 'mcp:a'])
    expect(out).toEqual(input)
    expect(out).toHaveLength(input.length)
    out.forEach((entry, i) => expect(entry).toBe(input[i]))
  })
})
