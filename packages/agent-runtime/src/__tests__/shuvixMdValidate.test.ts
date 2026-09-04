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

describe('validateShuvixMdText — workflow', () => {
  const workflowMd = (fm: string[], script = 'return 1'): string =>
    md('---', ...fm, '---', '', '```js workflow', script, '```', '')

  it('U11 合法 workflow md → valid 且 messages 为空', () => {
    expect(
      validateShuvixMdText('workflow', workflowMd(['shuvix: workflow v1', 'name: ok-wf']))
    ).toEqual({ status: 'valid', messages: [] })
  })

  it('U12 非法 workflow md（裸 on）→ invalid + 人读原因原样回传', () => {
    const result = validateShuvixMdText(
      'workflow',
      workflowMd(['shuvix: workflow v1', 'name: bad-wf', 'on: []'])
    )
    expect(result.status).toBe('invalid')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toContain("workflow 'bad-wf'")
    expect(result.messages[0]).toContain("bare 'on' key is not read")
    expect(result.messages[0]).toContain('the whole file is rejected')
  })

  it('U13 分工钉板：脚本体 JS 语法错但结构合法 → 此处仍 valid（脚本语法归宿主扫描侧）', () => {
    expect(
      validateShuvixMdText(
        'workflow',
        workflowMd(['shuvix: workflow v1', 'name: syntax-err'], 'return ((( oops')
      )
    ).toEqual({ status: 'valid', messages: [] })
  })

  it('U14 属性卡重组形状（无正文）→ valid：脚本块是正文的规则，不该让每份合法工作流亮红', () => {
    // 设置页的属性卡只把 frontmatter 片段送来校验（同 memory）。原样判定必然报
    // 「缺 js workflow 脚本块」—— 实际打开内置 auto-title 就会看到一条假红。
    const yaml = md(
      'shuvix: workflow v1',
      'name: ok-wf',
      'shuvix-workflow-on:',
      '  - trigger: session.turn-completed',
      '    when: event.turnCount == 2'
    )
    expect(validateShuvixMdText('workflow', recompose(yaml))).toEqual({
      status: 'valid',
      messages: []
    })
  })

  it('U15 送整份文件时缺脚本块仍判非法（占位只在无正文时补，不放宽真实文件的判定）', () => {
    const withBodyNoScript = md(
      '---',
      'shuvix: workflow v1',
      'name: no-script',
      '---',
      '',
      '说明文字'
    )
    const result = validateShuvixMdText('workflow', withBodyNoScript)
    expect(result.status).toBe('invalid')
    expect(result.messages[0]).toContain('js workflow')
  })
})

describe('validateShuvixMdText — bot', () => {
  const VALID_BOT = md('---', 'shuvix: bot v1', 'name: ok-bot', 'description: d', '---', 'Body')

  it('BV-1 合法整份 bot md → valid 且 messages 为空', () => {
    expect(validateShuvixMdText('bot', VALID_BOT)).toEqual({ status: 'valid', messages: [] })
  })

  it('BV-2 非法 bot md → invalid + 人读原因原样回传（横幅文案的唯一来源）', () => {
    const result = validateShuvixMdText(
      'bot',
      md('---', 'shuvix: bot v1', 'name: x', '---', 'Body'),
      'x'
    )
    expect(result.status).toBe('invalid')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toContain("bot 'x'")
    expect(result.messages[0]).toContain("'description' is required")
  })

  it('BV-3 属性卡重组形状（无正文）→ valid：含管线声明与槽位表的典型 frontmatter', () => {
    // 属性卡只送 frontmatter 片段；validate 在无正文时补一行占位正文把判定限定在字段上
    const yaml = md(
      'shuvix: bot v1',
      'name: ok-bot',
      'description: d',
      'shuvix-bot-pipeline: bot-chat',
      'shuvix-bot-agents:',
      '  intent: bot-intent',
      '  task: default'
    )
    expect(validateShuvixMdText('bot', recompose(yaml))).toEqual({ status: 'valid', messages: [] })
  })

  it('BV-4 片段里的 frontmatter 级错误照样判非法（占位只放宽正文，不放宽字段）', () => {
    const result = validateShuvixMdText(
      'bot',
      recompose(md('shuvix: bot v1', 'name: bad-bot', 'description: d', 'shuvix-bot-agents: 5'))
    )
    expect(result.status).toBe('invalid')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toContain('shuvix-bot-agents')
  })

  it('BV-5 bot 没有软告警通道：合法文件的 messages 恒空（与 policy 的 U6 相反）', () => {
    // 改制前「agents.task + 非空正文」会提示正文被弃用；现在正文是人设与记忆、槽位是
    // 普通 agent md，两者本就并存 —— 不存在任何「合法但有话说」的形状
    const result = validateShuvixMdText(
      'bot',
      recompose(
        md('shuvix: bot v1', 'name: ok-bot', 'description: d', 'shuvix-bot-agents: {task: t}')
      )
    )
    expect(result).toEqual({ status: 'valid', messages: [] })
  })

  it('BV-6 整份文件空正文 → valid，且解析器同判（「属性卡绿灯 / save 拒」的旧缺口已合上）', () => {
    // 正文是人设与记忆，可为空 —— 新建的 bot 什么都还没学；validate 与 parse 因此不再分歧
    const emptyBodyFile = md('---', 'shuvix: bot v1', 'name: ok-bot', 'description: d', '---', '')
    expect(validateShuvixMdText('bot', emptyBodyFile)).toEqual({ status: 'valid', messages: [] })
    expect(parseBotDefinitionFile(emptyBodyFile, 'ok-bot')?.body).toBe('')
  })

  it("BV-7 'bot' 不再落 unknown 分支（大小写不符的 'Bot' 仍是 unknown）", () => {
    expect(validateShuvixMdText('bot', VALID_BOT).status).not.toBe('unknown')
    expect(validateShuvixMdText('Bot', VALID_BOT)).toEqual({ status: 'unknown', messages: [] })
  })

  it('BV-8 name 透传进诊断；省略时缺省 file（与 policy 的 U7 同形）', () => {
    expect(validateShuvixMdText('bot', 'not a shuvix md', 'mybot.md').messages[0]).toContain(
      "bot 'mybot.md'"
    )
    expect(validateShuvixMdText('bot', 'not a shuvix md').messages[0]).toContain("bot 'file'")
  })

  it('BV-9 空文本 / 无 frontmatter → invalid + no YAML frontmatter block', () => {
    for (const text of ['', 'just a plain markdown body']) {
      const result = validateShuvixMdText('bot', text)
      expect(result.status, text).toBe('invalid')
      expect(result.messages, text).toHaveLength(1)
      expect(result.messages[0], text).toContain('no YAML frontmatter block')
    }
  })

  it('BV-10 旧的笔记分界线只是正文：valid 且 messages 为空（笔记区的软告警随概念一起消失）', () => {
    // 存量文件里可能还留着一条甚至几条 `<!-- shuvix:bot-notes -->`：它们既不切分正文也不
    // 触发告警 —— 人设和记忆是同一篇文档的不同段落，那条线读起来就是一条 HTML 注释
    const twoMarkers = md(
      '---',
      'shuvix: bot v1',
      'name: ok-bot',
      'description: d',
      '---',
      'PERSONA',
      '<!-- shuvix:bot-notes -->',
      'note',
      '<!-- shuvix:bot-notes -->',
      'more',
      ''
    )
    expect(validateShuvixMdText('bot', twoMarkers)).toEqual({ status: 'valid', messages: [] })
  })

  it('BV-11 三个 bot 键的 frontmatter 级错误照旧判红（占位只放宽正文，不放宽字段）', () => {
    for (const line of [
      'shuvix-bot-pipeline: 3',
      'shuvix-bot-input: [a]',
      'shuvix-bot-agents: 5'
    ]) {
      const result = validateShuvixMdText(
        'bot',
        recompose(md('shuvix: bot v1', 'name: bad-bot', 'description: d', line))
      )
      expect(result.status, line).toBe('invalid')
      expect(result.messages, line).toHaveLength(1)
      expect(result.messages[0], line).toContain(line.split(':')[0])
    }
  })

  it('BV-12 退役键连同改制前的非法值一起成了「未知键」→ valid 且 messages 为空', () => {
    // 属性卡因此对 `shuvix-bot-respond: sometimes` 亮绿灯 —— 这是与解析器一致的取舍
    // （botFile 的 BX-4）：存量文件里的退役键不能让升级后的 bot 从会话里消失
    for (const line of [
      'shuvix-bot-respond: sometimes',
      'shuvix-bot-notes: yes please',
      'shuvix-bot-greeting: [x]'
    ]) {
      expect(
        validateShuvixMdText(
          'bot',
          recompose(md('shuvix: bot v1', 'name: ok-bot', 'description: d', line))
        ),
        line
      ).toEqual({ status: 'valid', messages: [] })
    }
  })

  it('BV-13 agent 键在 bot 上是未知键：同一段 frontmatter 按 agent 判红、按 bot 判绿', () => {
    // bot 是一份绑定，不是 agent —— 工具 / 模型这些键归槽位里那份 agent md
    const yaml = md('shuvix: bot v1', 'name: twin', 'description: d', 'shuvix-tools: [read]')
    expect(validateShuvixMdText('agent', recompose(yaml)).status).toBe('invalid')
    expect(validateShuvixMdText('bot', recompose(yaml))).toEqual({ status: 'valid', messages: [] })
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
