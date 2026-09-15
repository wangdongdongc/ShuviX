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
import { parseBotDefinitionFile } from '../bot/botFile'
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

describe('validateShuvixMdText — hook', () => {
  const hookMd = (fm: string[], body = 'Do the thing.'): string =>
    md('---', ...fm, '---', '', body, '')
  const VALID_FM = [
    'shuvix: hook v1',
    'name: ok-hook',
    'shuvix-hook-agent: titler',
    'shuvix-hook-on:',
    '  - trigger: session.turn-completed',
    '    when: event.turnCount == 2'
  ]

  it('U11 合法 hook md → valid 且 messages 为空', () => {
    expect(validateShuvixMdText('hook', hookMd(VALID_FM))).toEqual({
      status: 'valid',
      messages: []
    })
  })

  it('U12 非法 hook md（裸 on）→ invalid + 人读原因原样回传', () => {
    const result = validateShuvixMdText(
      'hook',
      hookMd(['shuvix: hook v1', 'name: bad-hook', 'shuvix-hook-agent: titler', 'on: []'])
    )
    expect(result.status).toBe('invalid')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toContain("hook 'bad-hook'")
    expect(result.messages[0]).toContain("bare 'on' key is not read")
    expect(result.messages[0]).toContain('the whole file is rejected')
  })

  it('U13 点名基座档案（work）→ invalid：基座是会话人格，不可派发', () => {
    const result = validateShuvixMdText(
      'hook',
      hookMd(VALID_FM.map((l) => l.replace('shuvix-hook-agent: titler', 'shuvix-hook-agent: work')))
    )
    expect(result.status).toBe('invalid')
    expect(result.messages[0]).toContain('session base profile')
  })

  it('U14 属性卡重组形状（无正文）→ valid：正文是任务文本、可以为空，不需要占位补丁', () => {
    expect(validateShuvixMdText('hook', recompose(VALID_FM.join('\n')))).toEqual({
      status: 'valid',
      messages: []
    })
  })

  it('U15 未知埋点 id → 仍 valid，但带一条「绑定惰性」软提示（卡片亮琥珀）', () => {
    const result = validateShuvixMdText(
      'hook',
      hookMd(VALID_FM.map((l) => l.replace('session.turn-completed', 'file.changed')))
    )
    expect(result.status).toBe('valid')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toContain("trigger 'file.changed' is not known")
  })
})

describe('validateShuvixMdText — bot', () => {
  const VALID_BOT = md('---', 'shuvix: bot v2', 'name: scout', 'description: d', '---', 'Body')

  it('BV-1 合法整份 bot md → valid 且 messages 为空', () => {
    expect(validateShuvixMdText('bot', VALID_BOT)).toEqual({ status: 'valid', messages: [] })
  })

  it('BV-2 属性卡重组形状（无正文）→ valid：bot 的正文没有形状要求，不需要占位补丁', () => {
    // 空正文是新建出来的常态（由 bot 自己往里写），所以不像 memory 那样要替属性卡
    // 补一行占位正文 —— 原样解析就是对的
    expect(validateShuvixMdText('bot', recompose('shuvix: bot v2\nname: scout'))).toEqual({
      status: 'valid',
      messages: []
    })
  })

  it('BV-3 标记类型不符（一份 agent md 掉进 bots 目录）→ invalid + 点出期望的标记', () => {
    const r = validateShuvixMdText('bot', recompose('shuvix: agent v1\nname: coder'))
    expect(r.status).toBe('invalid')
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]).toContain("'shuvix: bot v2'")
  })

  it('BV-4 v1 残留的管线块 → valid + 恰一条软提示（卡片亮琥珀，文件照常可用）', () => {
    const legacy = md(
      '---',
      'shuvix: bot v1',
      'name: scout',
      'description: d',
      'shuvix-bot-pipeline:',
      '  workflow: bot-chat',
      '  agents:',
      '    intent: bot-intent',
      '    task: work',
      '---',
      'Body'
    )
    const r = validateShuvixMdText('bot', legacy)
    expect(r.status).toBe('valid')
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]).toContain("'shuvix-bot-pipeline' is no longer used")
    // 校验器与解析器同判：卡片亮琥珀的这份文件，注册表里也是一个活着的 bot，正文原样
    expect(parseBotDefinitionFile(legacy, 'scout')?.body).toBe('Body')
  })

  it('BV-5 字段类型错 → invalid + 人读原因原样回传（横幅文案的唯一来源）', () => {
    const r = validateShuvixMdText('bot', recompose('name: scout\ndescription: [a, b]'))
    expect(r.status).toBe('invalid')
    expect(r.messages[0]).toContain("'description' must be a string")
  })

  it('BV-6 name 透传进诊断；省略时缺省 file', () => {
    expect(validateShuvixMdText('bot', 'no frontmatter', 'scout.md').messages[0]).toMatch(
      /^bot 'scout\.md': /
    )
    expect(validateShuvixMdText('bot', 'no frontmatter').messages[0]).toMatch(/^bot 'file': /)
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
