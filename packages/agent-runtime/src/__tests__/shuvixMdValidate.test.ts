/**
 * validateShuvixMdText —— ChatApi `shuvixMd.validate` 的宿主无关实现（类型分派 + 真解析器复用）。
 *
 * 语义要点（对齐实现注释）：
 *   - agent 与 policy 的解析器都带 warn 通道 —— invalid 时给出人读拒绝原因；
 *   - policy 侧 invalid 恒有 ≥1 条消息，文件级 reject 文案含 "; the whole file is rejected"，
 *     规则级细因（如未知规则键）先于文件级 reject 入列 —— 顺序即属性卡横幅行序；
 *   - 其余类型（chart / wiki-*）是宽容读取的展示型契约，无校验器 → unknown 且 messages 恒空。
 */
import { describe, expect, it } from 'vitest'
import { validateShuvixMdText } from '../shuvixMdValidate'

const md = (...lines: string[]): string => lines.join('\n')

/** 属性卡校验入参的重组形状：`---\n<yaml>\n---\n`（合法性只由 frontmatter 决定） */
const recompose = (yaml: string): string => `---\n${yaml}\n---\n`

const VALID_AGENT = md('---', 'shuvix: agent v1', 'name: ok-agent', '---', 'Body')

const VALID_POLICY = md(
  '---',
  'shuvix: policy v1',
  'name: ok-policy',
  'shuvix-policy-rules:',
  '  - effect: ask',
  '    subject.kind: [agent]',
  '---',
  '',
  'Rationale body.'
)

describe('validateShuvixMdText — agent', () => {
  it('U1 合法 agent md → valid 且 messages 为空', () => {
    expect(validateShuvixMdText('agent', VALID_AGENT)).toEqual({ status: 'valid', messages: [] })
  })

  it('U2 非法 agent md → invalid 且带人读拒绝原因', () => {
    // (a) 无 frontmatter 的纯文本 —— 早期失败，who 回落 defaultName
    const noFm = validateShuvixMdText('agent', 'just a plain markdown body')
    expect(noFm.status).toBe('invalid')
    expect(noFm.messages).toHaveLength(1)
    expect(noFm.messages[0]).toContain('no YAML frontmatter block')
    expect(noFm.messages[0]).toContain('the whole file is rejected')

    // (b) frontmatter 是合法 YAML，但 shuvix-tools 为列表（仅接受逗号分隔字符串）
    // —— 此时 name 已解析出来，诊断以它为 who
    const listTools = md(
      '---',
      'shuvix: agent v1',
      'name: bad-agent',
      'shuvix-tools: [read, bash]',
      '---',
      'Body'
    )
    const badTools = validateShuvixMdText('agent', listTools)
    expect(badTools.status).toBe('invalid')
    expect(badTools.messages).toHaveLength(1)
    expect(badTools.messages[0]).toContain("agent 'bad-agent'")
    expect(badTools.messages[0]).toContain("'shuvix-tools'")
  })
})

describe('validateShuvixMdText — policy', () => {
  it('U3 合法 policy md → valid 且 messages 为空', () => {
    expect(validateShuvixMdText('policy', VALID_POLICY)).toEqual({ status: 'valid', messages: [] })
  })

  it('U4 规则带未知键 → invalid；规则级细因先于文件级 reject 入列（恰 2 条）', () => {
    const text = md(
      '---',
      'shuvix: policy v1',
      'name: bad-pol',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    subject.kind: [agent]',
      '    note: x',
      '---'
    )
    const result = validateShuvixMdText('policy', text)
    expect(result.status).toBe('invalid')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toContain("unknown rule key 'note'")
    expect(result.messages[1]).toContain('is invalid; the whole file is rejected')
  })

  it('U5 effect 未知（parseRule 静默路径）→ invalid；恰 1 条文件级 reject', () => {
    const text = md(
      '---',
      'shuvix: policy v1',
      'name: bad-effect',
      'shuvix-policy-rules:',
      '  - effect: block',
      '    subject.kind: [agent]',
      '---'
    )
    const result = validateShuvixMdText('policy', text)
    expect(result.status).toBe('invalid')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toContain('rejected')
  })

  it('U6 合法但带软告警（match 读客体属性却无 object.type 条件）→ valid + 恰 1 条含 object.type', () => {
    const text = md(
      '---',
      'shuvix: policy v1',
      'name: warn-pol',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    subject.kind: [agent]',
      `    match: "object.path != ''"`,
      '---'
    )
    const result = validateShuvixMdText('policy', text)
    expect(result.status).toBe('valid')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toContain('object.type')
  })

  it('U7 name 透传进诊断文案；省略时缺省 file', () => {
    const named = validateShuvixMdText('policy', 'not a shuvix md', 'mypol.md')
    expect(named.messages[0]).toContain("'mypol.md'")
    const fallback = validateShuvixMdText('policy', 'not a shuvix md')
    expect(fallback.messages[0]).toContain("'file'")
  })
})

describe('validateShuvixMdText — 类型路由与边界', () => {
  it.each(['chart', 'wiki-entry', 'wiki-topic', 'bogus', '', 'Agent'])(
    'U8 无校验器类型 %j → unknown 且 messages 为空',
    (type) => {
      expect(validateShuvixMdText(type, VALID_AGENT)).toEqual({ status: 'unknown', messages: [] })
    }
  )

  it('U9 空文本：agent / policy 均 invalid + no YAML frontmatter block', () => {
    const agent = validateShuvixMdText('agent', '')
    expect(agent.status).toBe('invalid')
    expect(agent.messages[0]).toContain('no YAML frontmatter block')
    const policy = validateShuvixMdText('policy', '')
    expect(policy.status).toBe('invalid')
    expect(policy.messages).toHaveLength(1)
    expect(policy.messages[0]).toContain('no YAML frontmatter block')
  })

  it('U10 属性卡重组形状（---\\n<yaml>\\n---\\n 无正文）→ 合法 agent / policy frontmatter 均 valid', () => {
    const agentYaml = md('shuvix: agent v1', 'name: ok-agent')
    expect(validateShuvixMdText('agent', recompose(agentYaml))).toEqual({
      status: 'valid',
      messages: []
    })
    const policyYaml = md(
      'shuvix: policy v1',
      'name: ok-pol',
      'shuvix-policy-rules:',
      '  - effect: ask',
      '    subject.kind: [agent]'
    )
    expect(validateShuvixMdText('policy', recompose(policyYaml))).toEqual({
      status: 'valid',
      messages: []
    })
  })
})
