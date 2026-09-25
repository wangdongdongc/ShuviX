/**
 * 侧栏「新建智能体」的初值（newAgentTemplate）—— 它落盘前要过 agent md 解析器（非法一律拒绝），
 * 所以钉的是「解析出来是什么」，不是模板的逐字文本：
 *
 *   G4 工具名单成对点名两个命令工具（`read, bash, powershell`）—— 宿主只装配这台机器上存在的那个，
 *      一份在 macOS 上新建的 agent 拷到 Windows 上照样有命令工具；
 *   G4b 三种界面语言的描述 / 正文代进去都是一份合法的 agent md（描述里的标点不会弄坏 YAML）。
 */
import { describe, expect, it } from 'vitest'
import { parseAgentDefinitionFile } from '@shuvix/agent-runtime'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import { newAgentTemplate } from '../agentTemplate'

/** 按 `a.b` 取 locale 里的文案（取不到回键名，与 i18next 的缺省行为一致） */
const translator =
  (resource: Record<string, unknown>) =>
  (key: string): string => {
    const hit = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        resource
      )
    return typeof hit === 'string' ? hit : key
  }

describe('newAgentTemplate', () => {
  it('G4 — 解析出的工具名单恰为 read, bash, powershell；名字就是传进来的那个', () => {
    const warnings: string[] = []
    const parsed = parseAgentDefinitionFile(
      newAgentTemplate((k) => k, 'my-agent'),
      'fallback-name',
      (msg) => warnings.push(msg)
    )
    expect(warnings).toEqual([])
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('my-agent')
    expect(parsed!.tools).toEqual(['read', 'bash', 'powershell'])
    // 新建的 agent 默认与内置档案同一套上下文注入
    expect(parsed!.instructionFiles).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(parsed!.projectAwareness).toBe(true)
  })

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ] as const)('G4b — %s 的文案代进去仍是合法的 agent md，描述与正文原样落位', (_lang, resource) => {
    const t = translator(resource as Record<string, unknown>)
    const description = t('tool.subAgentTemplateDesc')
    const body = t('tool.subAgentTemplateBody')
    // 文案真在资源里（不是回落成键名）
    expect(description).not.toBe('tool.subAgentTemplateDesc')
    expect(body).not.toBe('tool.subAgentTemplateBody')

    const parsed = parseAgentDefinitionFile(newAgentTemplate(t, 'my-agent'), 'fallback-name')
    expect(parsed).not.toBeNull()
    expect(parsed!.description).toBe(description)
    expect(parsed!.systemPrompt).toBe(body)
    expect(parsed!.tools).toEqual(['read', 'bash', 'powershell'])
  })
})
