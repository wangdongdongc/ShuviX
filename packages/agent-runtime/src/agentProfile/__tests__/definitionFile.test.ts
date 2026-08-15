import { describe, it, expect } from 'vitest'
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
    expect(parsed!.instructionFiles).toBe(false)
    expect(parsed!.projectPrompt).toBe(false)
  })

  it('解析 shuvix- 前缀字段与 mcp:/skill:/Agent 工具语法', () => {
    const md = [
      '---',
      'name: helper',
      'shuvix-displayName: 小助手',
      'description: does things',
      'shuvix-tools: read, mcp:Context7, skill:my-skill, agent',
      'shuvix-instruction-files: true',
      'shuvix-project-prompt: true',
      '---',
      'prompt body'
    ].join('\n')

    const parsed = parseAgentDefinitionFile(md, 'helper')!
    expect(parsed.displayName).toBe('小助手')
    // mcp:/skill: 前缀归小写、余部大小写保留；agent → 规范名 Agent
    expect(parsed.tools).toEqual(['read', 'mcp:Context7', 'skill:my-skill', 'Agent'])
    expect(parsed.instructionFiles).toBe(true)
    expect(parsed.projectPrompt).toBe(true)
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

  it('注入开关(instruction-files/project-prompt)非布尔 → 文件非法', () => {
    expect(
      parseAgentDefinitionFile('---\nshuvix-instruction-files: yes please\n---\nbody', 'x')
    ).toBeNull()
    expect(parseAgentDefinitionFile('---\nshuvix-project-prompt: [a]\n---\nbody', 'x')).toBeNull()
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
      tools: ['read', 'grep', 'mcp:Context7', 'skill:pdf', 'Agent'],
      instructionFiles: true,
      projectPrompt: true,
      dispatchOnly: false
    }
    const md = serializeAgentDefinitionFile(def)
    expect(md).toContain('shuvix-instruction-files: true')
    expect(md).toContain('shuvix-project-prompt: true')
    expect(parseAgentDefinitionFile(md, 'other-name')).toEqual(def)
  })

  it('省略规则：displayName 等于 name、空 description/tools、false 指令注入均不写 key', () => {
    const md = serializeAgentDefinitionFile({
      name: 'minimal',
      displayName: 'minimal',
      description: '',
      systemPrompt: 'body',
      tools: [],
      instructionFiles: false,
      projectPrompt: false,
      dispatchOnly: false
    })
    expect(md).toBe('---\nshuvix: agent v1\nname: minimal\n---\n\nbody\n')
    expect(parseAgentDefinitionFile(md, 'x')).toEqual({
      name: 'minimal',
      displayName: 'minimal',
      description: '',
      systemPrompt: 'body',
      tools: [],
      instructionFiles: false,
      projectPrompt: false,
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
      instructionFiles: false,
      projectPrompt: false,
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
      instructionFiles: true,
      projectPrompt: true,
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
      'shuvix-project-prompt'
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
      instructionFiles: true,
      projectPrompt: false,
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
      instructionFiles: false,
      projectPrompt: false,
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
      instructionFiles: false,
      projectPrompt: false,
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
      instructionFiles: false,
      projectPrompt: false,
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
      instructionFiles: false,
      projectPrompt: false,
      dispatchOnly: false
    })
    const parsed = parseAgentDefinitionFile(md, 'x')
    expect(parsed).not.toBeNull()
    expect(parsed!.description).toBe(description)
    expect(parsed!.systemPrompt).toBe('')
  })
})
