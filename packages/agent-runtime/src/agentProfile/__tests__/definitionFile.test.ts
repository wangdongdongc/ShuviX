import { describe, it, expect } from 'vitest'
import { SHUVIX_MD_DESCRIPTORS } from '@shuvix/chat-protocol/shuvixMdDescriptors'
import {
  parseAgentDefinitionFile,
  serializeAgentDefinitionFile,
  AGENT_FILE_MARKER,
  AGENT_FILE_MARKER_KEY
} from '../definitionFile'

describe('parseAgentDefinitionFile', () => {
  it('解析标准文件（description + 逗号分隔 shuvix-tools，大小写归一）', () => {
    const md = [
      '---',
      'name: code-reviewer',
      'description: Expert code review specialist. Use after writing code.',
      'shuvix-tools: Read, Grep, Glob, Bash',
      '---',
      '',
      'You are a senior code reviewer.'
    ].join('\n')

    const parsed = parseAgentDefinitionFile(md, 'fallback')
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('code-reviewer')
    expect(parsed!.displayName).toBe('code-reviewer')
    expect(parsed!.description).toBe('Expert code review specialist. Use after writing code.')
    expect(parsed!.tools).toEqual(['read', 'grep', 'glob', 'bash'])
    expect(parsed!.systemPrompt).toBe('You are a senior code reviewer.')
    // 新字段缺省
    expect(parsed!.instructionFiles).toEqual([])
    expect(parsed!.projectAwareness).toBe(false)
  })

  it('解析 shuvix- 前缀字段与 mcp:/skill:/agent 工具语法', () => {
    const md = [
      '---',
      'name: helper',
      'shuvix-displayName: 小助手',
      'description: does things',
      'shuvix-tools: read, mcp:Context7, skill:my-skill, Agent',
      'shuvix-instruction-files: AGENTS.md, CLAUDE.md',
      'shuvix-project-awareness: true',
      '---',
      'prompt body'
    ].join('\n')

    const parsed = parseAgentDefinitionFile(md, 'helper')!
    expect(parsed.displayName).toBe('小助手')
    // mcp:/skill: 前缀归小写、余部大小写保留；其余全小写（旧文件的 `Agent` 归一为 agent）
    expect(parsed.tools).toEqual(['read', 'mcp:Context7', 'skill:my-skill', 'agent'])
    expect(parsed.instructionFiles).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(parsed.projectAwareness).toBe(true)
  })

  it('shuvix-model 原样存取（本层不拆前缀、不对模型目录解析）', () => {
    const md = '---\nname: m\nshuvix-model: openai/gpt-4o\n---\nbody'
    expect(parseAgentDefinitionFile(md, 'm')!.model).toBe('openai/gpt-4o')
  })

  it('shuvix-model 省略 / 留空(YAML null) / 纯空白 三种写法同义 = 不声明', () => {
    expect(parseAgentDefinitionFile('---\nname: m\n---\nbody', 'm')!.model).toBeUndefined()
    expect(parseAgentDefinitionFile('---\nshuvix-model:\n---\nbody', 'm')!.model).toBeUndefined()
    expect(
      parseAgentDefinitionFile("---\nshuvix-model: '   '\n---\nbody", 'm')!.model
    ).toBeUndefined()
  })

  it('shuvix-model 非字符串（YAML 数组 / 布尔 / 数字）→ 文件非法', () => {
    expect(parseAgentDefinitionFile('---\nshuvix-model: [a]\n---\nbody', 'x')).toBeNull()
    expect(parseAgentDefinitionFile('---\nshuvix-model: true\n---\nbody', 'x')).toBeNull()
    // `shuvix-model: 4` 被 YAML 解析成 number —— 同样拒绝，宁可整体拒绝也不静默降级
    expect(parseAgentDefinitionFile('---\nshuvix-model: 4\n---\nbody', 'x')).toBeNull()
  })

  it('shuvix-model 值首尾空白被 trim', () => {
    const md = "---\nshuvix-model: '  openai/gpt-4o  '\n---\nbody"
    expect(parseAgentDefinitionFile(md, 'x')!.model).toBe('openai/gpt-4o')
  })

  it('注入开关(project-awareness)非布尔 → 文件非法', () => {
    expect(
      parseAgentDefinitionFile('---\nshuvix-project-awareness: [a]\n---\nbody', 'x')
    ).toBeNull()
    expect(
      parseAgentDefinitionFile('---\nshuvix-project-awareness: sure\n---\nbody', 'x')
    ).toBeNull()
  })

  it('shuvix-instruction-files 改制前的布尔写法 → 文件非法（拒绝理由指向文件清单）', () => {
    const warnings: string[] = []
    expect(
      parseAgentDefinitionFile('---\nshuvix-instruction-files: true\n---\nbody', 'x', (m) =>
        warnings.push(m)
      )
    ).toBeNull()
    expect(warnings.join('\n')).toContain('comma-separated file list')
    expect(
      parseAgentDefinitionFile('---\nshuvix-instruction-files: false\n---\nbody', 'x')
    ).toBeNull()
    // YAML 数组写法同样拒绝（与 shuvix-tools 同策：逗号分隔字符串是唯一合法写法）
    expect(
      parseAgentDefinitionFile('---\nshuvix-instruction-files: [AGENTS.md]\n---\nbody', 'x')
    ).toBeNull()
  })

  it('shuvix-instruction-files 条目归一：去重保序、剥 ./、反斜杠转正斜杠', () => {
    const md =
      '---\nshuvix-instruction-files: ./AGENTS.md, AGENTS.md, docs\\house.md, CLAUDE.md\n---\nbody'
    expect(parseAgentDefinitionFile(md, 'x')!.instructionFiles).toEqual([
      'AGENTS.md',
      'docs/house.md',
      'CLAUDE.md'
    ])
  })

  it('shuvix-instruction-files 越出工作目录（绝对路径 / ..）→ 文件非法', () => {
    for (const entry of ['/etc/passwd', 'C:/secrets.md', '../outside.md', 'a/../../b.md']) {
      expect(
        parseAgentDefinitionFile(`---\nshuvix-instruction-files: ${entry}\n---\nbody`, 'x'),
        entry
      ).toBeNull()
    }
  })

  it('shuvix-dispatch-only：布尔往返，缺省 false，非布尔视为文件非法', () => {
    const on = parseAgentDefinitionFile('---\nshuvix-dispatch-only: true\n---\nbody', 'x')
    expect(on!.dispatchOnly).toBe(true)
    expect(parseAgentDefinitionFile('---\nname: x\n---\nbody', 'x')!.dispatchOnly).toBe(false)
    expect(parseAgentDefinitionFile('---\nshuvix-dispatch-only: sure\n---\nbody', 'x')).toBeNull()
    // 序列化往返：false 不写 key（与其他布尔同策），true 必须写出，否则保存一次就丢了隔离
    expect(serializeAgentDefinitionFile({ ...on!, name: 'x' })).toContain(
      'shuvix-dispatch-only: true'
    )
    expect(serializeAgentDefinitionFile({ ...on!, name: 'x', dispatchOnly: false })).not.toContain(
      'shuvix-dispatch-only'
    )
  })

  it('正文里的 {{shuvix:*}} 占位符原样保留（替换发生在 createAgent，解析层不动）', () => {
    const md = '---\nname: vars\n---\nWorking dir: {{shuvix:workingDirectory}}'
    expect(parseAgentDefinitionFile(md, 'x')!.systemPrompt).toBe(
      'Working dir: {{shuvix:workingDirectory}}'
    )
  })

  it('旧方言与已废弃 key（whenToUse / displayName / shuvix-prompt-sections / 通用 tools）按未知 key 忽略', () => {
    const md = [
      '---',
      'name: legacy',
      'displayName: Old Name',
      'whenToUse: old style description',
      'tools: Read, Grep',
      'requiredMcp: serverA',
      'shuvix-prompt-sections: environment, workspace',
      '---',
      'body'
    ].join('\n')

    const parsed = parseAgentDefinitionFile(md, 'legacy')!
    expect(parsed.displayName).toBe('legacy')
    expect(parsed.description).toBe('')
    // 通用 tools key 视为其他 app 语义,忽略 → 空白名单
    expect(parsed.tools).toEqual([])
  })

  it('shuvix-tools 非字符串（如 YAML 数组）→ 文件非法', () => {
    expect(parseAgentDefinitionFile('---\nshuvix-tools: [read, grep]\n---\nbody', 'x')).toBeNull()
  })

  it('shuvix-tools 省略或空值 = 空白名单；name 省略回退文件名', () => {
    const md = '---\ndescription: no tools\n---\nbody'
    const parsed = parseAgentDefinitionFile(md, 'from-filename')!
    expect(parsed.name).toBe('from-filename')
    expect(parsed.tools).toEqual([])
    // `shuvix-tools:` 留空（YAML null）等同省略
    expect(parseAgentDefinitionFile('---\nshuvix-tools:\n---\nbody', 'x')!.tools).toEqual([])
  })

  it('支持完整 YAML：多行 block scalar、引号、注释', () => {
    const md = [
      '---',
      '# a comment',
      'name: multi',
      'description: >-',
      '  first line',
      '  second line',
      "shuvix-tools: 'read, grep'",
      '---',
      'body'
    ].join('\n')

    const parsed = parseAgentDefinitionFile(md, 'multi')!
    expect(parsed.description).toBe('first line second line')
    expect(parsed.tools).toEqual(['read', 'grep'])
  })

  it('工具列表去重保序', () => {
    const md = '---\nshuvix-tools: Read, read, grep, Grep\n---\nbody'
    expect(parseAgentDefinitionFile(md, 'x')!.tools).toEqual(['read', 'grep'])
  })

  it('容忍 CRLF 换行与 BOM', () => {
    const md = '\uFEFF---\r\nname: crlf\r\ndescription: windows file\r\n---\r\nbody line'
    const parsed = parseAgentDefinitionFile(md, 'x')!
    expect(parsed.name).toBe('crlf')
    expect(parsed.systemPrompt).toBe('body line')
  })

  it('无 frontmatter / YAML 非法 / 非对象 frontmatter → null', () => {
    expect(parseAgentDefinitionFile('just some markdown', 'x')).toBeNull()
    expect(parseAgentDefinitionFile('---\n[unclosed\n---\nbody', 'x')).toBeNull()
    expect(parseAgentDefinitionFile('---\n- a\n- b\n---\nbody', 'x')).toBeNull()
  })

  it('正文中段的 --- 块不是 frontmatter（文件必须以 --- 起始）→ null', () => {
    expect(parseAgentDefinitionFile('# Title\n\n---\nname: mid\n---\nbody', 'x')).toBeNull()
  })

  it('正文里的 --- 分隔线原样留在 systemPrompt（闭合定界线取最早的 --- 行）', () => {
    const md = '---\nname: x\n---\nintro\n\n---\noutro'
    expect(parseAgentDefinitionFile(md, 'x')!.systemPrompt).toBe('intro\n\n---\noutro')
    // 空 frontmatter 紧随的 --- 即闭合线，正文里再出现的 --- 不参与切割
    expect(parseAgentDefinitionFile('---\n---\nbody\n---\ntail', 'x')!.systemPrompt).toBe(
      'body\n---\ntail'
    )
  })

  it('空 frontmatter 合法：全部字段走缺省', () => {
    const parsed = parseAgentDefinitionFile('---\n---\nbody', 'empty')
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('empty')
    expect(parsed!.description).toBe('')
    expect(parsed!.systemPrompt).toBe('body')
  })
})

describe('serializeAgentDefinitionFile', () => {
  it('序列化→解析往返保真（全字段）', () => {
    const def = {
      name: 'reviewer',
      displayName: '审查助手',
      description: 'Expert reviewer: use after writing code. Handles edge-cases, too.',
      systemPrompt: 'You are a reviewer.\n\n- be thorough\n- cite lines',
      tools: ['read', 'grep', 'mcp:Context7', 'skill:pdf', 'agent'],
      instructionFiles: ['AGENTS.md', 'docs/house-rules.md'],
      projectAwareness: true,
      dispatchOnly: false
    }
    const md = serializeAgentDefinitionFile(def)
    expect(md).toContain('shuvix-instruction-files: AGENTS.md, docs/house-rules.md')
    expect(md).toContain('shuvix-project-awareness: true')
    expect(parseAgentDefinitionFile(md, 'other-name')).toEqual(def)
  })

  it('省略规则：displayName 等于 name、空 description/tools、空指令清单均不写 key', () => {
    const md = serializeAgentDefinitionFile({
      name: 'minimal',
      displayName: 'minimal',
      description: '',
      systemPrompt: 'body',
      tools: [],
      instructionFiles: [],
      projectAwareness: false,
      dispatchOnly: false
    })
    expect(md).toBe('---\nshuvix: agent v1\nname: minimal\n---\n\nbody\n')
    expect(parseAgentDefinitionFile(md, 'x')).toEqual({
      name: 'minimal',
      displayName: 'minimal',
      description: '',
      systemPrompt: 'body',
      tools: [],
      instructionFiles: [],
      projectAwareness: false,
      dispatchOnly: false
    })
  })

  it('shuvix-model：声明了才写 key（未声明 / 空串 / 纯空白均省略）', () => {
    const base = {
      name: 'm',
      displayName: 'm',
      description: '',
      systemPrompt: 'body',
      tools: [],
      instructionFiles: [],
      projectAwareness: false,
      dispatchOnly: false
    }
    expect(serializeAgentDefinitionFile({ ...base, model: 'openai/gpt-4o' })).toContain(
      'shuvix-model: openai/gpt-4o'
    )
    expect(serializeAgentDefinitionFile(base)).not.toContain('shuvix-model')
    expect(serializeAgentDefinitionFile({ ...base, model: '' })).not.toContain('shuvix-model')
    expect(serializeAgentDefinitionFile({ ...base, model: '   ' })).not.toContain('shuvix-model')
  })

  it('key 顺序固定：shuvix → name → description → tools → model → displayName → 注入开关', () => {
    const md = serializeAgentDefinitionFile({
      name: 'ordered',
      displayName: '显示名',
      description: 'd',
      systemPrompt: 'body',
      tools: ['read'],
      model: 'openai/gpt-4o',
      instructionFiles: ['AGENTS.md'],
      projectAwareness: true,
      dispatchOnly: false
    })
    const keys = md
      .split('\n---')[0]
      .split('\n')
      .slice(1)
      .map((line) => line.split(':')[0])
    expect(keys).toEqual([
      AGENT_FILE_MARKER_KEY,
      'name',
      'description',
      'shuvix-tools',
      'shuvix-model',
      'shuvix-displayName',
      'shuvix-instruction-files',
      'shuvix-project-awareness'
    ])
  })

  it.each([
    ['<provider>/<model>', 'openai/gpt-4o'],
    ['模型 id 自带斜杠', 'openrouter/anthropic/claude-3.5'],
    ['uuid 提供商前缀', '0192f0a1-7c4e-7c3a-9f10-2b6a5d0c1e77/gpt-4o']
  ])('含 model 的往返保真（%s）', (_label, model) => {
    const def = {
      name: 'withmodel',
      displayName: 'withmodel',
      description: 'has a model',
      systemPrompt: 'You are a helper.',
      tools: ['read', 'grep'],
      model,
      instructionFiles: ['AGENTS.md'],
      projectAwareness: false,
      dispatchOnly: false
    }
    expect(parseAgentDefinitionFile(serializeAgentDefinitionFile(def), 'other-name')).toEqual(def)
  })

  it.each([
    ['以 * 开头（YAML alias）', '*starred/model'],
    ['以 @ 开头（YAML 保留字符）', '@reserved/model'],
    ['含裸冒号', 'weird: provider/model']
  ])('含 YAML 危险字符的模型值经引号转义后仍解析回原值（%s）', (_label, model) => {
    const md = serializeAgentDefinitionFile({
      name: 'tricky-model',
      displayName: 'tricky-model',
      description: '',
      systemPrompt: 'body',
      tools: [],
      model,
      instructionFiles: [],
      projectAwareness: false,
      dispatchOnly: false
    })
    expect(parseAgentDefinitionFile(md, 'x')!.model).toBe(model)
  })

  it('文件类型标记 shuvix: agent v1 恒写在首位', () => {
    const md = serializeAgentDefinitionFile({
      name: 'marked',
      displayName: 'marked',
      description: '',
      systemPrompt: 'body',
      tools: [],
      instructionFiles: [],
      projectAwareness: false,
      dispatchOnly: false
    })
    expect(md.split('\n')[1]).toBe(`${AGENT_FILE_MARKER_KEY}: ${AGENT_FILE_MARKER}`)
  })

  it('标记可选：不带标记的旧档案照常解析（标记引入前的用户文件不能因此失效）', () => {
    const legacy = '---\nname: legacy\ndescription: old file\nshuvix-tools: read\n---\n\nbody'
    expect(parseAgentDefinitionFile(legacy, 'legacy')).toEqual({
      name: 'legacy',
      displayName: 'legacy',
      description: 'old file',
      systemPrompt: 'body',
      tools: ['read'],
      instructionFiles: [],
      projectAwareness: false,
      dispatchOnly: false
    })
  })

  it('特殊字符经 YAML 引号安全转义（含裸冒号、# 号、长文本不折行）', () => {
    const description = `Handles: everything # even hashes — ${'long text '.repeat(20)}end`
    const md = serializeAgentDefinitionFile({
      name: 'tricky',
      displayName: 'tricky',
      description,
      systemPrompt: '',
      tools: [],
      instructionFiles: [],
      projectAwareness: false,
      dispatchOnly: false
    })
    const parsed = parseAgentDefinitionFile(md, 'x')
    expect(parsed).not.toBeNull()
    expect(parsed!.description).toBe(description)
    expect(parsed!.systemPrompt).toBe('')
  })
})

/**
 * WU / DG —— parseAgentDefinitionFile 的 **warn 诊断通道**矩阵。
 *
 * 原文编辑（设置页的 md 编辑器 / 笔记本属性卡的校验横幅 / IPC 写路径的拒绝回执）下，
 * 用户一定会写出非法结构。此时只返回 null 说不清「哪里错了」—— 于是解析器给每条拒绝
 * 路径配了人读原因，那句话就是 UI 横幅与 IPC error 字段的**唯一**文案来源
 * （agentService.parseSourceForWrite 只是把它们 `\n` join 起来原样上抛）。
 *
 * 因此本组把每个拒绝分支的 who / why / 收尾语都钉住：
 *   - who：早期失败还没解析出 frontmatter `name`，只能报文件名；字段级失败必须报 name；
 *   - why：点名出错的键并给出正确写法（用户照着改就能修好）；
 *   - 收尾恒为「the whole file is rejected」—— 宁可整体拒绝也不静默降级，这句话是承诺本身。
 * DG-1 再守一遍完整性：任何返回 null 的输入都不得静默。
 */
describe('WU —— parseAgentDefinitionFile 的 warn 诊断通道', () => {
  /** 收集一次解析的全部诊断（warn 是可选参数，这里恒注入） */
  const parseWithWarn = (
    raw: string,
    defaultName = 'from-filename'
  ): { result: ReturnType<typeof parseAgentDefinitionFile>; messages: string[] } => {
    const messages: string[] = []
    const result = parseAgentDefinitionFile(raw, defaultName, (msg) => messages.push(msg))
    return { result, messages }
  }
  /** 只取唯一一条诊断（解析器对每份文件恰好报一次拒绝原因） */
  const soleWarn = (raw: string, defaultName?: string): string => {
    const { result, messages } = parseWithWarn(raw, defaultName)
    expect(result).toBeNull()
    expect(messages).toHaveLength(1)
    return messages[0]
  }

  it('WU-1 无 frontmatter：who 用文件名（此时还没有 name 可报），why 点明缺 YAML 块', () => {
    const msg = soleWarn('just some markdown', 'orphan.md')
    expect(msg).toContain("agent 'orphan.md'")
    expect(msg).toContain('no YAML frontmatter block')
  })

  it('WU-2 YAML 语法错：why 带 `invalid YAML (…)` 且透传 yaml 包的多行代码框原文', () => {
    const msg = soleWarn('---\n[unclosed\n---\nbody', 'broken.md')
    expect(msg).toContain("agent 'broken.md'")
    // 原始报错是「哪一行哪一列」的唯一来源，不能被概括掉
    expect(msg).toMatch(/invalid YAML \([\s\S]+\)/)
    expect(msg).toContain('at line 2, column 1')
    // 它是**多行**的（带 ^ 指位行）—— 展示端必须保留换行，压平会变乱码
    expect(msg.split('\n').length).toBeGreaterThan(1)
    expect(msg).toContain('^')
  })

  it('WU-3 frontmatter 不是映射（数组 / 纯标量）→ `frontmatter must be a mapping`', () => {
    expect(soleWarn('---\n- a\n- b\n---\nbody')).toContain('frontmatter must be a mapping')
    expect(soleWarn('---\njust a scalar\n---\nbody')).toContain('frontmatter must be a mapping')
  })

  it('WU-4 shuvix-tools 非字符串：点名该键并给出逗号分隔写法（照着改就能修好）', () => {
    const msg = soleWarn('---\nname: t\nshuvix-tools: [read, grep]\n---\nbody')
    expect(msg).toContain("'shuvix-tools'")
    expect(msg).toContain('comma-separated string')
    expect(msg).toContain('read, bash')
    expect(msg).toContain('not a list')
  })

  it('WU-5 shuvix-model 非字符串：点名该键并给出两种合法形状', () => {
    const msg = soleWarn('---\nname: m\nshuvix-model: [a]\n---\nbody')
    expect(msg).toContain("'shuvix-model'")
    expect(msg).toContain('must be a string')
    expect(msg).toContain('<modelId>')
    expect(msg).toContain('<provider>/<modelId>')
  })

  it('WU-6 shuvix-instruction-files 非字符串：点名该键并指路文件清单', () => {
    // 改制前的写法 `true` 是最真实的误写 —— 诊断必须说清「改列文件名」，否则用户
    // 只看到一份档案凭空消失
    const msg = soleWarn('---\nname: b\nshuvix-instruction-files: true\n---\nbody')
    expect(msg).toContain("'shuvix-instruction-files'")
    expect(msg).toContain('comma-separated file list')
    expect(msg).toContain('the boolean form is gone')
  })

  it('WU-14 shuvix-instruction-files 条目越界：点名该键并回显出问题的那一条', () => {
    const msg = soleWarn('---\nname: b\nshuvix-instruction-files: ../outside.md\n---\nbody')
    expect(msg).toContain("'shuvix-instruction-files'")
    expect(msg).toContain('../outside.md')
    expect(msg).toContain('relative path')
  })

  it.each([
    ['WU-7', 'shuvix-project-awareness'],
    ['WU-8', 'shuvix-dispatch-only']
  ])('%s %s 非布尔：点名该键并给出 true / false', (_id, key) => {
    // `yes please` 是最真实的误写：YAML 里 `yes` 本身是布尔，加了词才落回字符串
    const msg = soleWarn(`---\nname: b\n${key}: yes please\n---\nbody`)
    expect(msg).toContain(`'${key}'`)
    expect(msg).toContain('must be a boolean')
    expect(msg).toContain('true / false')
  })

  it('WU-9 who 的取舍：字段级失败报 frontmatter name，早期失败才回退文件名', () => {
    // 字段级失败：name 已经解析出来了，报它才对得上用户在编辑器里看到的档案
    expect(soleWarn('---\nname: real-name\nshuvix-tools: [x]\n---\nbody', 'file-name')).toContain(
      "agent 'real-name'"
    )
    // 没写 name 的字段级失败：回退文件名
    expect(soleWarn('---\nshuvix-tools: [x]\n---\nbody', 'file-name')).toContain(
      "agent 'file-name'"
    )
    // 早期失败（frontmatter 都没解析出来）：只能报文件名，即便正文里写着别的名字
    expect(soleWarn('name: real-name\nbody', 'file-name')).toContain("agent 'file-name'")
  })

  it('WU-10 每条诊断都以「the whole file is rejected」收尾（宁可整体拒绝也不静默降级）', () => {
    const cases = [
      'just some markdown',
      '---\n[unclosed\n---\nbody',
      '---\n- a\n---\nbody',
      '---\nshuvix-tools: [a]\n---\nbody',
      '---\nshuvix-model: 4\n---\nbody',
      '---\nshuvix-project-awareness: nope please\n---\nbody'
    ]
    for (const raw of cases) {
      expect(soleWarn(raw), raw).toMatch(/; the whole file is rejected$/)
    }
  })

  it('WU-11 合法文件不产生任何诊断（含空 frontmatter 与 YAML null frontmatter）', () => {
    for (const raw of [
      '---\nname: ok\nshuvix-tools: read, grep\n---\nbody',
      '---\n---\nbody',
      '---\n# 只有注释\n---\nbody'
    ]) {
      const { result, messages } = parseWithWarn(raw)
      expect(result, raw).not.toBeNull()
      // 有一条 warn 就会在属性卡上点亮告警徽章 —— 合法文件必须彻底安静
      expect(messages, raw).toEqual([])
    }
  })

  it('WU-12 warn 是可选参数：不传时行为完全一致（不抛、返回值不变）', () => {
    const invalid = '---\nname: x\nshuvix-tools: [a]\n---\nbody'
    const valid = '---\nname: x\nshuvix-tools: read\n---\nbody'
    expect(() => parseAgentDefinitionFile(invalid, 'x')).not.toThrow()
    expect(parseAgentDefinitionFile(invalid, 'x')).toBeNull()
    expect(parseAgentDefinitionFile(valid, 'x')).toEqual(parseWithWarn(valid).result)
  })
})

describe('DG —— 诊断完整性守卫', () => {
  it('DG-1 没有静默拒绝：任何被判非法的输入都恰好产出一条人读原因', () => {
    // 覆盖解析器的全部拒绝分支（无 frontmatter / YAML 错 / 非映射 / 两个字符串键 / 两个布尔键）
    const rejected = [
      'no frontmatter at all',
      '# Title\n\n---\nname: mid\n---\nbody',
      '---\n[unclosed\n---\nbody',
      '---\n- a\n- b\n---\nbody',
      '---\nshuvix-tools: [read]\n---\nbody',
      '---\nshuvix-tools: true\n---\nbody',
      '---\nshuvix-model: 4\n---\nbody',
      '---\nshuvix-model: [a]\n---\nbody',
      '---\nshuvix-instruction-files: true\n---\nbody',
      '---\nshuvix-instruction-files: ../outside.md\n---\nbody',
      '---\nshuvix-project-awareness: [a]\n---\nbody',
      '---\nshuvix-dispatch-only: sure\n---\nbody'
    ]
    for (const raw of rejected) {
      const messages: string[] = []
      const result = parseAgentDefinitionFile(raw, 'guard.md', (msg) => messages.push(msg))
      // 返回 null ⇒ 必须说清为什么（IPC 的 error 字段与横幅都只有这一个来源）
      expect(result, raw).toBeNull()
      expect(messages, raw).toHaveLength(1)
      // [\s\S] 而非 . —— YAML 语法错的原因本身是多行代码框
      expect(messages[0], raw).toMatch(/^agent '.+': [\s\S]+; the whole file is rejected$/)
    }
  })
})

/**
 * WB —— frontmatter 属性卡「行级写回」的解析契约（调用方追加的转义用例落在 WB-2..WB-6）。
 *
 * 卡片绝不整体重序列化 frontmatter：它只改一行（改值段 / 闭合线前插行 / 整行删除），
 * 所以「写出的那一行能不能被本解析器原样读回」就是这条编辑链路的全部正确性前提。
 * 本组把卡片会写出的每种行形态钉在解析器这一侧（app-shell 的 yamlScalar 是它的镜像）：
 *   - 安全值裸写、危险值加单引号（含 ` #` / `: ` / 指示符起头 / 内含单引号 / 首尾空白）；
 *   - 反例同测：不加引号会被 YAML 怎样误读 —— 这才是引号规则的存在理由；
 *   - 单行重写破坏不了的形态（行尾注释 / 块标量续行）在卡片侧退回只读，
 *     此处钉住「若真去重写首行会得到什么」，为那道守卫留下依据。
 */
describe('WB —— 属性卡行级写回的解析契约', () => {
  /** 把若干 frontmatter 行拼成最小 agent 文件（正文固定，便于断言未被波及） */
  const fileOf = (...lines: string[]): string =>
    ['---', 'shuvix: agent v1', 'name: card-agent', ...lines, '---', '', 'BODY.', ''].join('\n')

  /** 单引号标量（内部单引号成对转义）—— 与 frontmatterCard.yamlScalar 的写出规则一致 */
  const quoted = (value: string): string => `'${value.replace(/'/g, "''")}'`

  it('WB-1 安全值裸写：卡片对不含危险字符的值不加引号，解析器原样回读', () => {
    const parsed = parseAgentDefinitionFile(
      fileOf('shuvix-tools: read, grep', 'shuvix-model: openai/gpt-4o'),
      'x'
    )!
    expect(parsed.tools).toEqual(['read', 'grep'])
    expect(parsed.model).toBe('openai/gpt-4o')
  })

  it('WB-2 值含 ` #`：裸写被 YAML 截成注释（反例），加单引号后逐字回读', () => {
    // 反例 —— 用户自取的 MCP server 名带 `#` 时，裸写会静默丢掉后半段
    const naive = parseAgentDefinitionFile(fileOf('shuvix-tools: read, mcp:tag #1'), 'x')!
    expect(naive.tools).toEqual(['read', 'mcp:tag'])

    const value = 'read, mcp:tag #1'
    const safe = parseAgentDefinitionFile(fileOf(`shuvix-tools: ${quoted(value)}`), 'x')!
    expect(safe.tools).toEqual(['read', 'mcp:tag #1'])
    // 模型 ref 同理（注释截断在这里会让整个 model 变成半截串）
    const model = 'openrouter/some #tagged'
    expect(parseAgentDefinitionFile(fileOf(`shuvix-model: ${model}`), 'x')!.model).toBe(
      'openrouter/some'
    )
    expect(parseAgentDefinitionFile(fileOf(`shuvix-model: ${quoted(model)}`), 'x')!.model).toBe(
      model
    )
  })

  it('WB-3 值含 `: `：裸写让 YAML 读成嵌套映射/整份非法（反例），加单引号后回读', () => {
    // 裸写 `shuvix-model: weird: provider/model` → YAML 语法错，整份文件被拒
    expect(parseAgentDefinitionFile(fileOf('shuvix-model: weird: provider/model'), 'x')).toBeNull()

    const model = 'weird: provider/model'
    expect(parseAgentDefinitionFile(fileOf(`shuvix-model: ${quoted(model)}`), 'x')!.model).toBe(
      model
    )
  })

  it.each([
    ['YAML alias 指示符', '*starred/model'],
    ['YAML anchor 指示符', '&anchored/model'],
    ['保留字符 @', '@reserved/model'],
    ['序列指示符 -', '- dashed/model'],
    ['流式序列 [', '[bracketed]/model'],
    ['块标量指示符 >', '>folded/model']
  ])('WB-4 值以 YAML 指示符起头（%s）：加单引号后回读原值', (_label, model) => {
    expect(parseAgentDefinitionFile(fileOf(`shuvix-model: ${quoted(model)}`), 'x')!.model).toBe(
      model
    )
  })

  it("WB-5 值内含单引号：'' 成对转义后回读原值（引号规则自身不能把值改写掉）", () => {
    const model = "o'brien/model"
    const line = `shuvix-model: ${quoted(model)}`
    expect(line).toBe("shuvix-model: 'o''brien/model'")
    expect(parseAgentDefinitionFile(fileOf(line), 'x')!.model).toBe(model)
  })

  it('WB-6 值首尾空白 / 空串：加引号写出后仍是「未声明 / 空白名单」而非非法文件', () => {
    // 首尾空白：引号保住了它进 YAML，解析器再 trim —— 等价于未声明
    expect(
      parseAgentDefinitionFile(fileOf(`shuvix-model: ${quoted('  ')}`), 'x')!.model
    ).toBeUndefined()
    expect(
      parseAgentDefinitionFile(fileOf(`shuvix-model: ${quoted('')}`), 'x')!.model
    ).toBeUndefined()
    // 空串 tools（卡片删空时其实走整行删除，见 WU-11；这里钉住降级写法也不炸）
    expect(parseAgentDefinitionFile(fileOf(`shuvix-tools: ${quoted('')}`), 'x')!.tools).toEqual([])
  })

  it('WB-7 行尾注释：注释不属于值 —— 单行重写必然吞掉它，故该形态退回只读', () => {
    const parsed = parseAgentDefinitionFile(fileOf('shuvix-tools: read, grep # 保留这条注释'), 'x')!
    // 解析结果里没有注释的任何痕迹：写回时无从把它还原回去
    expect(parsed.tools).toEqual(['read', 'grep'])
    // 「注释保真」是本模块的承诺，而值段与注释同处一行 —— 重写值段 = 连注释一起改掉
    const rewritten = fileOf('shuvix-tools: read, grep, ls')
    expect(rewritten).not.toContain('# 保留这条注释')
    expect(parseAgentDefinitionFile(rewritten, 'x')!.tools).toEqual(['read', 'grep', 'ls'])
  })

  it('WB-8 块标量续行：只重写首行 → 值静默吞掉孤儿续行；写成引号标量则整份非法', () => {
    const ok = parseAgentDefinitionFile(
      fileOf('description: >-', '  first line', '  second line'),
      'x'
    )!
    expect(ok.description).toBe('first line second line')

    // 卡片若把首行改成 `description: new value`，续行没有归属 —— YAML 按纯标量折行把它们
    // **并进值里**：不报错、不可见，用户下次打开才发现描述变成了一段拼接文本
    const swallowed = fileOf('description: new value', '  first line', '  second line')
    expect(parseAgentDefinitionFile(swallowed, 'x')!.description).toBe(
      'new value first line second line'
    )
    // 值需要加引号时更糟：缩进行与引号标量不能同列 → 整份文件解析失败
    const broken = fileOf(`description: ${quoted('new: value')}`, '  first line', '  second line')
    expect(parseAgentDefinitionFile(broken, 'x')).toBeNull()
  })

  it('WB-9 改值段只动一行：注释 / 非规范键序 / 未知键 / 正文全部原样', () => {
    const before = [
      '---',
      'shuvix: agent v1',
      '# 用户手写的注释',
      'description: keeps its place',
      'name: card-agent',
      'shuvix-builtin: true',
      'shuvix-tools: read',
      '---',
      '',
      'BODY line one.',
      '',
      'BODY line two.',
      ''
    ].join('\n')
    // 行级写回的产物：只有 shuvix-tools 那一行的值段变了
    const after = before.replace('shuvix-tools: read', 'shuvix-tools: read, grep')

    const a = parseAgentDefinitionFile(before, 'x')!
    const b = parseAgentDefinitionFile(after, 'x')!
    expect(a.tools).toEqual(['read'])
    expect(b.tools).toEqual(['read', 'grep'])
    // 其余字段逐字段相等 —— 键序/注释/未知键/正文都没被重序列化带走
    expect({ ...b, tools: a.tools }).toEqual(a)
    expect(after).toContain('# 用户手写的注释')
    expect(after).toContain('shuvix-builtin: true')
    expect(after.split('---\n')[2]).toBe(before.split('---\n')[2])
  })

  it('WB-10 键不存在 → 闭合线前插行：新行仍在 frontmatter 内且被读到，正文不受影响', () => {
    const before = fileOf('shuvix-tools: read')
    // setScalarKey 的插入点：闭合定界线之前
    const after = before.replace('---\n\nBODY.', 'shuvix-model: openai/gpt-4o\n---\n\nBODY.')

    const parsed = parseAgentDefinitionFile(after, 'x')!
    expect(parsed.model).toBe('openai/gpt-4o')
    expect(parsed.tools).toEqual(['read'])
    expect(parsed.systemPrompt).toBe('BODY.')
  })

  it('WB-11 整行删除（chips 删空）：无 shuvix-tools 键 = 空白名单，且不留空值行', () => {
    const before = fileOf('shuvix-tools: read', 'shuvix-model: openai/gpt-4o')
    const after = before.replace('shuvix-tools: read\n', '')

    expect(after).not.toContain('shuvix-tools')
    const parsed = parseAgentDefinitionFile(after, 'x')!
    expect(parsed.tools).toEqual([])
    // 其他键零影响
    expect(parsed.model).toBe('openai/gpt-4o')
    expect(parsed.name).toBe('card-agent')
  })

  it('WB-12 CRLF 文件里插入 LF 行：混合换行仍可解析（写回不会把文件变成解析失败）', () => {
    const before = '---\r\nshuvix: agent v1\r\nname: crlf-agent\r\n---\r\nBODY.\r\n'
    // CM6 按文档换行符插入，但用户文件混用换行的情形真实存在 —— 钉住最坏情况
    const after = before.replace('---\r\nBODY.', 'shuvix-tools: read, grep\n---\r\nBODY.')

    const parsed = parseAgentDefinitionFile(after, 'x')!
    expect(parsed.name).toBe('crlf-agent')
    expect(parsed.tools).toEqual(['read', 'grep'])
    expect(parsed.systemPrompt).toBe('BODY.')
  })
})

/**
 * DG —— 属性卡描述符（chat-protocol，静态数据）与本解析器（agent-runtime）的键集对齐守卫。
 * 两者分居两包、无编译期联系：描述符多写一个键，卡片就会渲染一行「解析器根本不读」的字段；
 * 少写一个，用户改不到。kind 也必须与解析器强制的值类型一致，否则卡片给出的编辑控件
 * 写出的值会被解析器判非法。
 */
describe('WB —— 属性卡描述符与解析器的键集对齐', () => {
  const agentDescriptor = SHUVIX_MD_DESCRIPTORS.find((d) => d.type === 'agent')!

  it('WB-13 描述符字段 = 解析器实际读取的键，且 kind 与解析器强制的值类型一致', () => {
    // 解析器实际读取的键（definitionFile.ts 的字段白名单）
    expect(agentDescriptor.fields.map((f) => f.key)).toEqual([
      'name',
      'shuvix-displayName',
      'description',
      'shuvix-model',
      'shuvix-tools',
      'shuvix-instruction-files',
      'shuvix-project-awareness',
      'shuvix-dispatch-only'
    ])

    // boolean kind 的键 = 解析器强制布尔的两个（非布尔即整份非法）
    const booleanKeys = agentDescriptor.fields
      .filter((f) => f.kind === 'boolean')
      .map((f) => f.key)
      .sort()
    expect(booleanKeys).toEqual(['shuvix-dispatch-only', 'shuvix-project-awareness'])
    for (const key of booleanKeys) {
      expect(parseAgentDefinitionFile(`---\n${key}: nope\n---\nbody`, 'x'), key).toBeNull()
      expect(parseAgentDefinitionFile(`---\n${key}: true\n---\nbody`, 'x'), key).not.toBeNull()
    }

    // csv / select（可点选编辑的两类）的键 = 解析器强制字符串的三个
    const stringKeys = agentDescriptor.fields
      .filter((f) => f.kind === 'csv' || f.kind === 'select')
      .map((f) => f.key)
      .sort()
    expect(stringKeys).toEqual(['shuvix-instruction-files', 'shuvix-model', 'shuvix-tools'])
    for (const key of stringKeys) {
      expect(parseAgentDefinitionFile(`---\n${key}: [a, b]\n---\nbody`, 'x'), key).toBeNull()
    }

    // 描述符里没有的键落通用 key/value 行 —— 解析器同样不读（自述标记 shuvix-builtin 是活样本）
    const parsed = parseAgentDefinitionFile('---\nname: x\nshuvix-builtin: true\n---\nbody', 'x')!
    expect(agentDescriptor.fields.some((f) => f.key === 'shuvix-builtin')).toBe(false)
    expect(Object.values(parsed)).not.toContain('shuvix-builtin')
  })
})
