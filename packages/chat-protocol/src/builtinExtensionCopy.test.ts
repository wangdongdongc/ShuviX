/**
 * 内置技能 / 内置 MCP / 内置知识库的界面文案查表（BEC）—— 认哪些名字、不认哪些名字。
 * 文案本身在三语里齐不齐由各自的清单用例钉：技能在桌面的 builtinSkillsResources（BS-9），
 * MCP 在 builtinMcpPresentations.test（BMP-9 / BMP-12）。
 */
import { describe, expect, it } from 'vitest'
import {
  builtinKnowledgeCopy,
  builtinMcpCopy,
  builtinSkillCopy,
  sameAsIdentifier
} from './builtinExtensionCopy'
import en from './i18n/locales/en.json'
import ja from './i18n/locales/ja.json'
import zh from './i18n/locales/zh.json'

/** 只认真实存在的叶子键，缺了就把键原样还回去（i18next 的缺省行为） */
function tOf(bundle: unknown): (key: string) => string {
  return (key) => {
    const found = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        bundle
      )
    return typeof found === 'string' ? found : key
  }
}

describe('builtinExtensionCopy', () => {
  it('BEC-1 内置技能认 builtin:<name> 与 skill:builtin:<name>，按界面语言给名字与说明', () => {
    expect(builtinSkillCopy('builtin:drawing', tOf(zh))?.label).toBe('绘图')
    expect(builtinSkillCopy('skill:builtin:drawing', tOf(en))?.label).toBe('Drawing')
    expect(builtinSkillCopy('skill:builtin:widget', tOf(zh))).toEqual({
      label: '小组件',
      hint: zh.builtinSkill.widget.hint
    })
  })

  it('BEC-2 不是内置的技能不给文案：同名的用户技能、外部目录里的、原型上的名字', () => {
    const t = tOf(en)
    expect(builtinSkillCopy('drawing', t)).toBeUndefined()
    expect(builtinSkillCopy('skill:drawing', t)).toBeUndefined()
    expect(builtinSkillCopy('agents:drawing', t)).toBeUndefined()
    expect(builtinSkillCopy('builtin:pdf', t)).toBeUndefined()
    expect(builtinSkillCopy('builtin:toString', t)).toBeUndefined()
    expect(builtinSkillCopy('builtin:constructor', t)).toBeUndefined()
  })

  it('BEC-3 内置 MCP 认 server 名与 mcp:<name>，名字与工具调用块的标签是同一个键', () => {
    expect(builtinMcpCopy('browser', tOf(zh))).toEqual({
      label: '浏览器',
      hint: zh.tool.browserHint
    })
    expect(builtinMcpCopy('mcp:database', tOf(en))?.label).toBe(en.tool.remoteDbLabel)
    expect(builtinMcpCopy('mcp:ssh', tOf(en))?.hint).toBe(en.tool.sshHint)
    expect(builtinMcpCopy('chrome', tOf(en))?.hint).toBe(en.tool.chromeHint)
  })

  it('BEC-4 别的 server 不给文案：自定义名、带前缀的冒名、原型上的名字', () => {
    const t = tOf(en)
    expect(builtinMcpCopy('github', t)).toBeUndefined()
    expect(builtinMcpCopy('mcp:browser__x', t)).toBeUndefined()
    expect(builtinMcpCopy('toString', t)).toBeUndefined()
    expect(builtinMcpCopy('mcp:hasOwnProperty', t)).toBeUndefined()
  })

  it('BEC-6 内置知识库只认保留名 shuvix：名字与说明按界面语言给，三语都有；用户库与 project 不给', () => {
    for (const bundle of [en, zh, ja]) {
      expect(builtinKnowledgeCopy('shuvix', tOf(bundle))).toEqual({
        label: bundle.knowledge.builtinBaseName,
        hint: bundle.knowledge.builtinBase
      })
      expect(bundle.knowledge.builtinBaseName).toBeTruthy()
      expect(bundle.knowledge.builtinBase).toBeTruthy()
    }
    const t = tOf(en)
    expect(builtinKnowledgeCopy('notes', t)).toBeUndefined()
    expect(builtinKnowledgeCopy('project', t)).toBeUndefined()
    expect(builtinKnowledgeCopy('Shuvix', t)).toBeUndefined()
  })

  it('BEC-5 名字与标识名只差大小写时算同一个（SSH / ssh），不同就不算（Drawing / widget）', () => {
    expect(sameAsIdentifier('SSH', 'ssh')).toBe(true)
    expect(sameAsIdentifier('Browser', 'browser')).toBe(true)
    expect(sameAsIdentifier('Widgets', 'widget')).toBe(false)
    expect(sameAsIdentifier('浏览器', 'browser')).toBe(false)
  })
})

describe('builtinExtensionCopy — 任务列表', () => {
  it('COPY-1 plan 与 mcp:plan：名字与说明是任务列表的那两个键', () => {
    const T = (key: string): string => `T(${key})`
    const expected = { label: 'T(tool.taskListLabel)', hint: 'T(tool.taskListHint)' }
    expect(builtinMcpCopy('plan', T)).toStrictEqual(expected)
    expect(builtinMcpCopy('mcp:plan', T)).toStrictEqual(expected)
  })
})
