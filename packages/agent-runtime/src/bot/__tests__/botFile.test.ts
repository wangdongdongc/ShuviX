/**
 * bot 定义文件（`shuvix: bot v1`）的解析 / 序列化契约。
 *
 * **一个 bot 是一份绑定：身份 + 管线绑定块 + 一篇正文。** 它自己不再是 agent ——
 * 模型 / 工具 / 指令文件这些是槽位里那份 agent md 的事，写在 bot 上只是被忽略（BX 组）。
 *
 * 管线绑定是**一个嵌套映射** `shuvix-bot-pipeline: { workflow, agents, input }`：
 *   - `workflow` **必填、没有缺省** —— 写着 bot 的文件必须自己说用哪条管线，缺了整份非法；
 *     `TEMPLATE_BOT_PIPELINE`（bot-chat）只是「新建 bot」模板预填的名字，解析器不读它；
 *   - `agents` 是开放的「槽位 → agent 名」表、`input` 是给管线的入参 —— 两者都是**这份管线**
 *     的从属项，所以住在同一个键下（换了工作流，槽位表就整个换一套）。
 *   改制前的顶层键 `shuvix-bot-agents` / `shuvix-bot-input` 与标量形 `shuvix-bot-pipeline: x`
 *   一律整份拒绝并指明新写法（BR-8 / BR-14）—— 不迁移：静默忽略等于让用户的槽位表悄悄消失。
 *
 * 处理方式与 agent md 同族同策：文件类型标记写入恒有、读取可选；未知键忽略；类型不符 =
 * 整份非法（null + warn 人读原因，**恰一条**）。只有一处比 agent md 严：**description
 * 必填非空** —— 意图段靠它判断相关性，others 块里别的成员也只靠它认识这个 bot。
 *
 * 正文是这个 bot 的**人设与记忆**（可为空 —— 新建的 bot 什么都还没学），由宿主围栏后
 * 追加到参与执行的每个 agent 的系统提示词末尾（renderBotContext，契约在 botContext.test.ts）。
 * 没有分界线、没有笔记区、也就没有「状态区软失败」：这一层只剩「定义区硬失败」一种失败，
 * warn 通道因此恢复了 agent md 的「恰一条诊断」不变式（BR-15）。
 *
 * 分组：
 *   BP 合法形状与缺省 · BR 整份拒绝清单 · BX 宽松侧（未知键 / 退役键 / agent 键 / 裸键 / 标记）·
 *   BS 序列化 · BD 属性卡描述符与解析器的对齐
 *
 * 断言到消息文本时一律用子串/正则而非全等：拒绝理由是 UI 横幅与 IPC error 的唯一
 * 文案来源，要钉的是「点名了哪个键、给没给正确写法」，不是标点。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BOT_PIPELINE_AGENTS_KEY as PROTOCOL_AGENTS_KEY,
  BOT_PIPELINE_INPUT_KEY as PROTOCOL_INPUT_KEY,
  BOT_PIPELINE_KEY as PROTOCOL_PIPELINE_KEY,
  BOT_PIPELINE_WORKFLOW_KEY as PROTOCOL_WORKFLOW_KEY,
  SHUVIX_MD_DESCRIPTORS
} from '@shuvix/chat-protocol/shuvixMdDescriptors'
import { parseAgentDefinitionFile } from '../../agentProfile/definitionFile'
import {
  BOT_FILE_MARKER,
  BOT_FILE_MARKER_KEY,
  BOT_PIPELINE_AGENTS_KEY,
  BOT_PIPELINE_INPUT_KEY,
  BOT_PIPELINE_KEY,
  BOT_PIPELINE_WORKFLOW_KEY,
  TEMPLATE_BOT_PIPELINE,
  parseBotDefinitionFile,
  serializeBotDefinitionFile,
  type ParsedBotFile
} from '../botFile'

const md = (...lines: string[]): string => lines.join('\n')

/** 管线块的两条最小行：`shuvix-bot-pipeline:` + 缩进的 `workflow: <name>` */
const pipelineBlock = (workflow = 'bot-chat'): string[] => [
  `${BOT_PIPELINE_KEY}:`,
  `  ${BOT_PIPELINE_WORKFLOW_KEY}: ${workflow}`
]

/** description + 正文，**没有**管线块 —— 用来摆管线键本身的各种错误形状 */
const bare = (...fm: string[]): string => md('---', 'description: d', ...fm, '---', 'body')

/** 最小合法 bot：bare + 一个合法管线块（workflow: bot-chat）；`fm` 追加在顶层、管线块之后 */
const bot = (...fm: string[]): string => bare(...pipelineBlock(), ...fm)

/** 合法 bot，管线块由调用方逐行给（子行自带缩进）—— agents / input 这些从属项都在块里 */
const withPipeline = (...inner: string[]): string => bare(`${BOT_PIPELINE_KEY}:`, ...inner)

/** 块内常用行（两空格缩进 = 管线块的直接子键） */
const WF = `  ${BOT_PIPELINE_WORKFLOW_KEY}: my-flow`
const AGENTS = `  ${BOT_PIPELINE_AGENTS_KEY}:`
const INPUT = `  ${BOT_PIPELINE_INPUT_KEY}:`

/** 收集一次解析的全部诊断 */
const parseWithWarn = (
  raw: string,
  defaultName = 'fn'
): { result: ParsedBotFile | null; messages: string[] } => {
  const messages: string[] = []
  const result = parseBotDefinitionFile(raw, defaultName, (m) => messages.push(m))
  return { result, messages }
}

/** 只取拒绝理由（恰一条，且以 `; the whole file is rejected` 收尾） */
const rejectReason = (raw: string, defaultName = 'fn'): string => {
  const { result, messages } = parseWithWarn(raw, defaultName)
  expect(result, raw).toBeNull()
  expect(messages, raw).toHaveLength(1)
  expect(messages[0], raw).toMatch(/; the whole file is rejected$/)
  return messages[0]
}

/** ParsedBotFile 的全部字段名（新增字段先在 BS-2 失败） */
const PARSED_BOT_KEYS = [
  'agents',
  'body',
  'description',
  'displayName',
  'name',
  'pipeline',
  'pipelineInput'
]

// ────────────────────────────── BP：合法形状与缺省 ──────────────────────────────

describe('BP —— 解析：合法形状与缺省', () => {
  it('BP-1 最小合法文件（description + 管线块的 workflow + 正文）', () => {
    const parsed = parseBotDefinitionFile(bot(), 'fn')
    expect(parsed).not.toBeNull()
    // name 省略回退文件 basename，displayName 再回退 name
    expect(parsed!.name).toBe('fn')
    expect(parsed!.displayName).toBe('fn')
    expect(parsed!.description).toBe('d')
    expect(parsed!.pipeline).toBe('bot-chat')
    expect(parsed!.body).toBe('body')
  })

  it('BP-2 全字段文件逐字段落位（身份 + 管线块：workflow / input / 开放槽位表 + 正文）', () => {
    // 槽位表刻意混入管线之外的名字（gate）—— 槽位集合归管线 workflow 定义，本层只校形状
    const raw = md(
      '---',
      `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`,
      'name: full-bot',
      'description: does everything',
      'shuvix-displayName: 全能 bot',
      `${BOT_PIPELINE_KEY}:`,
      `  ${BOT_PIPELINE_WORKFLOW_KEY}: my-pipeline`,
      `  ${BOT_PIPELINE_INPUT_KEY}:`,
      '    tone: terse',
      `  ${BOT_PIPELINE_AGENTS_KEY}:`,
      '    intent: my-intent',
      '    task: my-task',
      '    gate: my-gate',
      '---',
      'Persona paragraph.',
      '',
      '## What I learned',
      '',
      '- prefers pnpm'
    )
    expect(parseBotDefinitionFile(raw, 'other-name')).toEqual({
      name: 'full-bot',
      displayName: '全能 bot',
      description: 'does everything',
      // 正文是**整篇**（人设与记忆是同一篇文档的不同段落，没有分界线、没有条目格式）
      body: md('Persona paragraph.', '', '## What I learned', '', '- prefers pnpm'),
      pipeline: 'my-pipeline',
      pipelineInput: { tone: 'terse' },
      agents: { intent: 'my-intent', task: 'my-task', gate: 'my-gate' }
    })
  })

  it('BP-3 缺省表：pipelineInput={} / agents={} / displayName=name —— 而 workflow **没有缺省**', () => {
    const parsed = parseBotDefinitionFile(bot(), 'fn')!
    expect(parsed.pipelineInput).toEqual({})
    expect(parsed.agents).toEqual({})
    expect(parsed.displayName).toBe(parsed.name)
    // 没有缺省管线：块里没写 workflow 的文件解析不出来，而不是回落到模板常量（BR-9）
    expect(parseBotDefinitionFile(withPipeline(AGENTS, '    task: t'), 'fn')).toBeNull()
  })

  it('BP-4 三个可选键留空（YAML null）等同省略 —— 编辑器里最常见的中间态不得判非法', () => {
    // displayName 在顶层，agents / input 在块里；workflow 留空则是 BR-9 的拒绝
    const parsed = parseBotDefinitionFile(
      bare('shuvix-displayName:', `${BOT_PIPELINE_KEY}:`, WF, AGENTS, INPUT),
      'fn'
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.displayName).toBe('fn')
    expect(parsed!.pipeline).toBe('my-flow')
    expect(parsed!.pipelineInput).toEqual({})
    expect(parsed!.agents).toEqual({})
  })

  it('BP-5 agents: {} / input: {} 空映射合法', () => {
    const parsed = parseBotDefinitionFile(
      withPipeline(WF, `  ${BOT_PIPELINE_AGENTS_KEY}: {}`, `  ${BOT_PIPELINE_INPUT_KEY}: {}`),
      'fn'
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.agents).toEqual({})
    expect(parsed!.pipelineInput).toEqual({})
  })

  it('BP-6 值两侧空白被 trim（name / displayName / description / workflow / 槽位值）', () => {
    const parsed = parseBotDefinitionFile(
      md(
        '---',
        "name: '  spaced  '",
        "description: '  d  '",
        "shuvix-displayName: '  Spaced  '",
        `${BOT_PIPELINE_KEY}:`,
        `  ${BOT_PIPELINE_WORKFLOW_KEY}: '  my-flow  '`,
        AGENTS,
        "    intent: '  my-intent  '",
        '---',
        'body'
      ),
      'fn'
    )!
    expect(parsed.name).toBe('spaced')
    expect(parsed.description).toBe('d')
    expect(parsed.displayName).toBe('Spaced')
    expect(parsed.pipeline).toBe('my-flow')
    expect(parsed.agents.intent).toBe('my-intent')
  })

  it('BP-7 正文两端 trim、内部逐字保留；{{shuvix:*}} 原样（替换发生在 createAgent）', () => {
    const raw = md(
      '---',
      'description: d',
      ...pipelineBlock(),
      '---',
      '',
      '',
      'Working dir: {{shuvix:workingDirectory}}',
      '',
      '- a list',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      ''
    )
    expect(parseBotDefinitionFile(raw, 'fn')!.body).toBe(
      md(
        'Working dir: {{shuvix:workingDirectory}}',
        '',
        '- a list',
        '',
        '```js',
        'const x = 1',
        '```'
      )
    )
  })

  it('BP-8 **正文可为空**（新建的 bot 什么都还没学；围栏照样渲染，见 botContext）', () => {
    // 改制前「正文即任务段系统提示词」让空正文整份非法；现在正文是人设与记忆，
    // 空就是「还没有」—— 任务段 agent 会在第一次学到东西时往里写
    for (const raw of [
      md('---', 'description: d', ...pipelineBlock(), '---', ''),
      md('---', 'description: d', ...pipelineBlock(), '---', '', '   ', '\t', '')
    ]) {
      const { result, messages } = parseWithWarn(raw)
      expect(result, raw).not.toBeNull()
      expect(result!.body, raw).toBe('')
      expect(messages, raw).toEqual([])
    }
  })

  it('BP-9 容忍 BOM 与 CRLF（共享 splitFrontmatter 的能力在 bot 侧同样成立，嵌套块也不例外）', () => {
    const raw = `\uFEFF---\r\nname: crlf\r\ndescription: windows file\r\n${BOT_PIPELINE_KEY}:\r\n  ${BOT_PIPELINE_WORKFLOW_KEY}: my-flow\r\n  ${BOT_PIPELINE_AGENTS_KEY}:\r\n    intent: i\r\n---\r\nbody line\r\n`
    const parsed = parseBotDefinitionFile(raw, 'fn')!
    expect(parsed.name).toBe('crlf')
    expect(parsed.description).toBe('windows file')
    expect(parsed.pipeline).toBe('my-flow')
    expect(parsed.agents).toEqual({ intent: 'i' })
    expect(parsed.body).toBe('body line')
    expect(parsed.body).not.toContain('\r')
  })

  it('BP-10 **没有缺省管线**：workflow 写什么就是什么；TEMPLATE_BOT_PIPELINE 只是模板常量，解析器不读它', () => {
    // 改制前 `shuvix-bot-pipeline` 缺省 bot-chat；现在缺了整份非法（BR-8 / BR-9），而
    // 「新建 bot」模板预填的 bot-chat 与用户自写的 my-flow 在解析器眼里没有任何区别
    expect(TEMPLATE_BOT_PIPELINE).toBe('bot-chat')
    expect(parseBotDefinitionFile(bot(), 'fn')!.pipeline).toBe(TEMPLATE_BOT_PIPELINE)
    expect(parseBotDefinitionFile(withPipeline(WF), 'fn')!.pipeline).toBe('my-flow')
    // 没写块 / 块留空：不回落，直接 null
    expect(parseBotDefinitionFile(bare(), 'fn')).toBeNull()
    expect(parseBotDefinitionFile(withPipeline(), 'fn')).toBeNull()
  })

  it('BP-11 input 任意 YAML 映射原样透传（格式层不校验内容）', () => {
    // 它是给管线 workflow 的入参 —— 嵌套映射 / 数组 / null 原样落位
    const parsed = parseBotDefinitionFile(
      withPipeline(WF, INPUT, '    a:', '      b: [1, 2]', '    n:'),
      'fn'
    )!
    expect(parsed.pipelineInput).toEqual({ a: { b: [1, 2] }, n: null })
  })

  it('BP-12 **开放槽位表：任意槽位名被接受**，零 warn（槽位集合归管线 workflow 定义）', () => {
    // 把槽位枚举写死在格式层，等于让 md 格式追着某一份管线的实现走：内置 bot-chat 要
    // intent / task（可选 recheck），别的管线自有别的槽位
    const { result, messages } = parseWithWarn(
      withPipeline(WF, AGENTS, '    gate: g', '    reply: r', '    Ok-Role_2: o', '    x-1: x')
    )
    expect(result).not.toBeNull()
    expect(result!.agents).toEqual({ gate: 'g', reply: 'r', 'Ok-Role_2': 'o', 'x-1': 'x' })
    expect(messages).toEqual([])
  })

  it.each([['a'], ['A'], ['a_b'], ['a-b'], ['Z9']])('BP-13a 合法槽位名形状（%s）', (role) => {
    expect(
      parseBotDefinitionFile(withPipeline(WF, AGENTS, `    ${role}: x`), 'fn')!.agents[role]
    ).toBe('x')
  })

  it.each([
    ['数字开头', '1st'],
    ['下划线开头', '_x'],
    ['含空格', 'bad role'],
    ['空串', "''"]
  ])('BP-13b 非法槽位名形状（%s）整份拒绝', (_label, role) => {
    const msg = rejectReason(withPipeline(WF, AGENTS, `    ${role}: x`))
    expect(msg).toContain(`'${BOT_PIPELINE_KEY}.${BOT_PIPELINE_AGENTS_KEY}'`)
    expect(msg).toContain('is not a valid slot name')
  })

  it('BP-14 指向不存在的 workflow / agent **不判非法**（惰性化：文件可后补，宿主对照注册表现判）', () => {
    // 哪些槽位必填、填了不存在的 agent 怎么办，都是宿主对照管线才知道的事（桌面的
    // botService.advise 在属性卡上提示）；本层只管形状，运行时在会话里可见地说明
    for (const raw of [
      withPipeline(`  ${BOT_PIPELINE_WORKFLOW_KEY}: nope-not-a-real-workflow`),
      withPipeline(WF, AGENTS, '    intent: nope-not-a-real-agent')
    ]) {
      const { result, messages } = parseWithWarn(raw)
      expect(result, raw).not.toBeNull()
      expect(messages, raw).toEqual([])
    }
  })

  it('BP-15 正文里的 `---` 不重开 frontmatter', () => {
    const raw = md(
      '---',
      'description: d',
      ...pipelineBlock(),
      '---',
      'PERSONA',
      '',
      '---',
      '',
      'after a rule'
    )
    const parsed = parseBotDefinitionFile(raw, 'fn')!
    expect(parsed.description).toBe('d')
    expect(parsed.body).toBe(md('PERSONA', '', '---', '', 'after a rule'))
  })

  it('BP-16 流式写法 `{ workflow: …, agents: { … } }` 与块写法等价（同一份 YAML，本层不分）', () => {
    // 属性卡改这种文件时会先把它摊成块（frontmatterPatch），那是编辑器的事，解析器只看值
    const parsed = parseBotDefinitionFile(
      bare(
        `${BOT_PIPELINE_KEY}: { ${BOT_PIPELINE_WORKFLOW_KEY}: my-flow, ${BOT_PIPELINE_AGENTS_KEY}: { intent: i, task: t }, ${BOT_PIPELINE_INPUT_KEY}: { tone: terse } }`
      ),
      'fn'
    )!
    expect(parsed.pipeline).toBe('my-flow')
    expect(parsed.agents).toEqual({ intent: 'i', task: 't' })
    expect(parsed.pipelineInput).toEqual({ tone: 'terse' })
  })
})

// ────────────────────────────── BR：整份拒绝清单 ──────────────────────────────

describe('BR —— 整份拒绝清单（逐条 + warn 人读原因）', () => {
  it('BR-1 无 frontmatter / 正文中段的 --- 块 → 早期失败，who 回退 basename', () => {
    const msg = rejectReason('just a plain markdown body', 'orphan.md')
    expect(msg).toContain("bot 'orphan.md'")
    expect(msg).toContain('no YAML frontmatter block')
    expect(rejectReason('# Title\n\n---\nname: mid\ndescription: d\n---\nbody')).toContain(
      'no YAML frontmatter block'
    )
  })

  it('BR-2 YAML 语法错：透传 yaml 包的多行报错（含 ^ 指位行）', () => {
    const msg = rejectReason('---\n[unclosed\n---\nbody', 'broken.md')
    expect(msg).toContain("bot 'broken.md'")
    expect(msg).toMatch(/invalid YAML \([\s\S]+\)/)
    expect(msg).toMatch(/at line \d+/)
    expect(msg.split('\n').length).toBeGreaterThan(1)
    expect(msg).toContain('^')
  })

  it('BR-3 frontmatter 非映射（数组 / 纯标量）', () => {
    expect(rejectReason('---\n- a\n- b\n---\nbody')).toContain('frontmatter must be a mapping')
    expect(rejectReason('---\njust a scalar\n---\nbody')).toContain('frontmatter must be a mapping')
  })

  it('BR-4 description 缺失 —— bot 唯一比 agent 严的一条（且排在管线检查之前）', () => {
    const msg = rejectReason('---\nname: x\n---\nbody')
    expect(msg).toContain("'description' is required")
    expect(msg).toContain('the intent stage uses it to judge relevance')
    // 同一份文件在 agent 解析器下是合法的 —— 这条严格是 bot 专属
    expect(parseAgentDefinitionFile('---\nname: x\n---\nbody', 'x')).not.toBeNull()
  })

  it.each([
    ['纯空白', "description: '   '"],
    ['留空（YAML null）', 'description:']
  ])('BR-5 description %s 等同缺失', (_label, line) => {
    expect(rejectReason(md('---', 'name: x', line, '---', 'body'))).toContain(
      "'description' is required"
    )
  })

  it.each([
    ['数字', '42'],
    ['布尔', 'true'],
    ['列表', '[a]']
  ])('BR-6 description 非字符串（%s）→ 点名 description 必须是字符串', (_label, v) => {
    // 与「缺失」分开报：`description: 42` 是写了但写错了形状，提示「必填」会让人去补第二个
    expect(rejectReason(md('---', 'name: x', `description: ${v}`, '---', 'body'))).toContain(
      "'description' must be a string"
    )
  })

  it.each([
    ['数字', '42'],
    ['布尔', 'true'],
    ['列表', '[a]']
  ])('BR-7 shuvix-displayName 非字符串（%s）', (_label, v) => {
    expect(rejectReason(bot(`shuvix-displayName: ${v}`))).toContain(
      "'shuvix-displayName' must be a string"
    )
  })

  it.each([
    ['整个缺失', []],
    ['留空（YAML null）', [`${BOT_PIPELINE_KEY}:`]],
    ['改制前的标量形', [`${BOT_PIPELINE_KEY}: bot-chat`]],
    ['数字', [`${BOT_PIPELINE_KEY}: 3`]],
    ['列表', [`${BOT_PIPELINE_KEY}: [a, b]`]],
    ['空串', [`${BOT_PIPELINE_KEY}: ''`]]
  ])(
    'BR-8 shuvix-bot-pipeline 必须是映射（%s）→ 点名必填，并把新写法写在拒绝理由里',
    (_label, fm) => {
      const msg = rejectReason(bare(...fm))
      expect(msg).toContain(`'${BOT_PIPELINE_KEY}' is required`)
      // 拒绝理由本身就是新写法的说明书：三个子键都点名
      expect(msg).toContain(`'${BOT_PIPELINE_WORKFLOW_KEY}'`)
      expect(msg).toContain(`'${BOT_PIPELINE_AGENTS_KEY}'`)
      expect(msg).toContain(`'${BOT_PIPELINE_INPUT_KEY}'`)
    }
  )

  it('BR-8b 改制前的标量形 **不迁移**：即便值正是模板管线也整份拒绝，理由是「缺块」不是「pipeline 非字符串」', () => {
    // 按旧格式写全的存量文件，槽位表在顶层 shuvix-bot-agents 里 —— 那条先被 BR-14 拦下；
    // 只写了标量管线名的文件走到这里，读到的必须是「要一个带 workflow 的映射」
    const msg = rejectReason(bare(`${BOT_PIPELINE_KEY}: ${TEMPLATE_BOT_PIPELINE}`))
    expect(msg).toContain(`'${BOT_PIPELINE_KEY}' is required — a mapping`)
    expect(msg).not.toContain('must be the name of a workflow')
  })

  it.each([
    ['缺失（块里只有 agents）', withPipeline(AGENTS, '    task: t')],
    ['空映射 {}（块在、workflow 不在）', bare(`${BOT_PIPELINE_KEY}: {}`)],
    ['留空（YAML null）', withPipeline(`  ${BOT_PIPELINE_WORKFLOW_KEY}:`)],
    ['空串', withPipeline(`  ${BOT_PIPELINE_WORKFLOW_KEY}: ''`)],
    ['纯空白', withPipeline(`  ${BOT_PIPELINE_WORKFLOW_KEY}: '  '`)],
    ['数字', withPipeline(`  ${BOT_PIPELINE_WORKFLOW_KEY}: 3`)],
    ['列表', withPipeline(`  ${BOT_PIPELINE_WORKFLOW_KEY}: [a, b]`)],
    ['映射', withPipeline(`  ${BOT_PIPELINE_WORKFLOW_KEY}: {a: 1}`)]
  ])('BR-9 shuvix-bot-pipeline.workflow 必须是非空字符串（%s）—— 没有缺省可回落', (_label, raw) => {
    expect(rejectReason(raw)).toContain(
      `'${BOT_PIPELINE_KEY}.${BOT_PIPELINE_WORKFLOW_KEY}' must be the name of a workflow`
    )
  })

  it.each([
    ['列表', '[a]'],
    ['字符串', 'my-input'],
    ['数字', '7']
  ])('BR-10 shuvix-bot-pipeline.input 必须是映射（%s）', (_label, v) => {
    expect(rejectReason(withPipeline(WF, `  ${BOT_PIPELINE_INPUT_KEY}: ${v}`))).toContain(
      `'${BOT_PIPELINE_KEY}.${BOT_PIPELINE_INPUT_KEY}' must be a mapping of parameters for the pipeline workflow`
    )
  })

  it.each([
    ['列表', '[a, b]'],
    ['字符串', 'my-agent'],
    ['数字', '5']
  ])('BR-11 shuvix-bot-pipeline.agents 必须是映射（%s）', (_label, v) => {
    expect(rejectReason(withPipeline(WF, `  ${BOT_PIPELINE_AGENTS_KEY}: ${v}`))).toContain(
      `'${BOT_PIPELINE_KEY}.${BOT_PIPELINE_AGENTS_KEY}' must be a mapping of slot → agent name`
    )
  })

  it.each([
    ['空串', "''"],
    ['留空（YAML null）', ''],
    ['数字', '42'],
    ['嵌套映射', '{ nested: x }']
  ])('BR-12 槽位值必须是 agent 名（%s）', (_label, v) => {
    expect(rejectReason(withPipeline(WF, AGENTS, `    intent: ${v}`))).toContain(
      `'${BOT_PIPELINE_KEY}.${BOT_PIPELINE_AGENTS_KEY}.intent' must be an agent name`
    )
  })

  it('BR-13 who 的取舍：字段级失败报 frontmatter name，早期失败报 basename', () => {
    expect(
      rejectReason(
        md(
          '---',
          'name: real-name',
          'description: d',
          `${BOT_PIPELINE_KEY}:`,
          WF,
          `  ${BOT_PIPELINE_AGENTS_KEY}: 5`,
          '---',
          'b'
        ),
        'file.md'
      )
    ).toContain("bot 'real-name'")
    expect(rejectReason('name: real-name\nbody', 'file.md')).toContain("bot 'file.md'")
  })

  it.each([
    ['shuvix-bot-agents', BOT_PIPELINE_AGENTS_KEY],
    ['shuvix-bot-input', BOT_PIPELINE_INPUT_KEY]
  ])(
    'BR-14 改制前的顶层键 %s → 整份拒绝：点名退役键并指明它在新块里的位置（%s），值是什么都不看',
    (retired, subKey) => {
      // 与 BX-4 那批静默退役的键不同：这两个是旧形状的**骨架**，静默忽略等于让用户的槽位表 /
      // 入参悄悄消失，跑起来才在会话里报「必填槽位没填」—— 拒绝并说明新写法才是对存量文件负责。
      // 用 bot()：即便新块也在（用户改了一半），旧键还在就拒
      for (const value of [':', ': {}', ':\n  intent: bot-intent', ': 5']) {
        const raw = bot(`${retired}${value}`)
        const msg = rejectReason(raw)
        expect(msg, raw).toContain(`'${retired}' is no longer supported`)
        expect(msg, raw).toContain(`under '${BOT_PIPELINE_KEY}' as '${subKey}'`)
        // 新块的三个子键都在理由里 —— 不让用户再去翻文档
        expect(msg, raw).toContain(`'${BOT_PIPELINE_WORKFLOW_KEY}'`)
      }
    }
  )

  it('BR-14b 一份原封不动的旧格式文件：报的是退役键（更有用），不是「缺 workflow」；两个退役键同在也只报一条', () => {
    const legacy = md(
      '---',
      `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`,
      'name: legacy',
      'description: d',
      `${BOT_PIPELINE_KEY}: bot-chat`,
      'shuvix-bot-input:',
      '  tone: terse',
      'shuvix-bot-agents:',
      '  intent: bot-intent',
      '  task: default',
      '---',
      'PERSONA'
    )
    const msg = rejectReason(legacy)
    expect(msg).toMatch(/'shuvix-bot-(agents|input)' is no longer supported/)
    expect(msg).not.toContain('is required')
  })

  it('BR-15 拒绝完整性守卫：每条拒绝路径恰一条诊断，且形状固定', () => {
    // 没有软失败通道之后，agent 侧「恰一条诊断」的不变式在 bot 上重新成立 ——
    // 消费方（botService.parseForWrite 把 messages join 成 error）读到的永远就是那一句原因
    const rejected = [
      'just a plain markdown body',
      '# Title\n\n---\nname: mid\ndescription: d\n---\nbody',
      '---\n[unclosed\n---\nbody',
      '---\n- a\n- b\n---\nbody',
      '---\njust a scalar\n---\nbody',
      '---\nname: x\n---\nbody',
      "---\nname: x\ndescription: '   '\n---\nbody",
      '---\nname: x\ndescription: 42\n---\nbody',
      bot('shuvix-displayName: [x]'),
      bare(),
      bare(`${BOT_PIPELINE_KEY}:`),
      bare(`${BOT_PIPELINE_KEY}: bot-chat`),
      bare(`${BOT_PIPELINE_KEY}: [a]`),
      bare(`${BOT_PIPELINE_KEY}: {}`),
      withPipeline(`  ${BOT_PIPELINE_WORKFLOW_KEY}:`),
      withPipeline(`  ${BOT_PIPELINE_WORKFLOW_KEY}: 3`),
      withPipeline(AGENTS, '    task: t'),
      withPipeline(WF, `  ${BOT_PIPELINE_INPUT_KEY}: [a]`),
      withPipeline(WF, `  ${BOT_PIPELINE_AGENTS_KEY}: [a]`),
      withPipeline(WF, AGENTS, '    "bad role": x'),
      withPipeline(WF, AGENTS, '    _x: y'),
      withPipeline(WF, AGENTS, '    intent: 42'),
      withPipeline(WF, AGENTS, '    intent: { nested: x }'),
      bot('shuvix-bot-agents:', '  intent: x'),
      bot('shuvix-bot-input: {}')
    ]
    for (const raw of rejected) {
      const { result, messages } = parseWithWarn(raw, 'guard.md')
      expect(result, raw).toBeNull()
      expect(messages, raw).toHaveLength(1)
      // [\s\S] 而非 . —— YAML 语法错的原因本身是多行代码框
      expect(messages[0], raw).toMatch(/^bot '.+': [\s\S]+; the whole file is rejected$/)
    }
  })

  it('BR-16 warn 是可选参数：不传时不抛、返回值一致', () => {
    const invalid = withPipeline(WF, `  ${BOT_PIPELINE_AGENTS_KEY}: 5`)
    const valid = withPipeline(WF, AGENTS, '    intent: i')
    expect(() => parseBotDefinitionFile(invalid, 'fn')).not.toThrow()
    expect(parseBotDefinitionFile(invalid, 'fn')).toBeNull()
    expect(parseBotDefinitionFile(valid, 'fn')).toEqual(parseWithWarn(valid).result)
  })
})

// ────────────────────────────── BX：宽松侧 ──────────────────────────────

describe('BX —— 宽松侧（与 agent md 同口径）', () => {
  it('BX-1 缺文件类型标记仍可解析（写入恒有、读取可选）', () => {
    expect(parseBotDefinitionFile(bot(), 'fn')).not.toBeNull()
  })

  it.each([['agent v1'], ['workflow v1'], ['whatever']])(
    'BX-2 标记值不符（shuvix: %s）**不**判非法 —— 解析器根本不读标记',
    (marker) => {
      // 刻意的宽松钉板：与 docs/bot-design.md §4.4「缺标记/标记不符整份非法」相冲突。
      // bots 目录是平铺扫描的，误投一份 agent md 进来即成为一个 bot；若将来在
      // 「标记存在但类型不符」时改判非法，本例反转为拒绝用例。
      expect(
        parseBotDefinitionFile(
          md('---', `shuvix: ${marker}`, 'description: d', ...pipelineBlock(), '---', 'body'),
          'fn'
        )
      ).not.toBeNull()
    }
  )

  it('BX-3 无前缀陌生键忽略（tools / whenToUse / shuvix-builtin），零 warn', () => {
    const { result, messages } = parseWithWarn(
      bot('tools: Read, Grep', 'whenToUse: old style', 'shuvix-builtin: true')
    )
    expect(result).not.toBeNull()
    expect(messages).toEqual([])
    expect(Object.keys(result!).sort()).toEqual(PARSED_BOT_KEYS)
  })

  it.each([
    ['shuvix-bot-respond', 'sometimes'],
    ['shuvix-bot-respond-to', '[all]'],
    ['shuvix-bot-notes', 'yes please'],
    ['shuvix-bot-greeting', '[x]'],
    ['shuvix-bot-suggestions', 'a, b']
  ])('BX-4 退役键 %s 是普通未知键：连改制前的非法值也只是被忽略', (key, value) => {
    // 这些键连同门控轴 / 笔记 / 开场白 / 建议问题一起退役了。存量文件里写着它们的 bot
    // 必须照常可用 —— 判非法等于让一次升级把用户正在用的 bot 从会话里删掉。
    // 值刻意取改制前会整份拒绝的形状：现在它只是一个没人读的键。
    // （例外是 shuvix-bot-agents / shuvix-bot-input 两个结构键 —— 见 BR-14 的理由）
    const { result, messages } = parseWithWarn(bot(`${key}: ${value}`))
    expect(result, key).not.toBeNull()
    expect(messages, key).toEqual([])
    // 产物里也没有它们的影子（respond / notesEnabled / greeting / suggestions 都不再是字段）
    expect(Object.keys(result!).sort(), key).toEqual(PARSED_BOT_KEYS)
  })

  it('BX-5 **agent md 的键写在 bot 上被忽略**（bot 是绑定不是 agent），同一段在 agent 侧却非法', () => {
    // 模型 / 工具 / 指令文件 / 项目感知 / 会话感知归槽位里那份 agent md。
    // 值同样刻意取 agent 解析器会拒绝的形状（列表 tools、数字 model、越界指令文件、
    // 非布尔开关）—— 证明这里不是「宽容地解析了」，而是压根不读
    const agentKeys = [
      'shuvix-tools: [read, bash]',
      'shuvix-model: 4',
      'shuvix-instruction-files: ../outside.md',
      'shuvix-project-awareness: yes please',
      'shuvix-session-awareness: true'
    ]
    const { result, messages } = parseWithWarn(bot(...agentKeys))
    expect(result).not.toBeNull()
    expect(messages).toEqual([])
    for (const leak of [
      'tools',
      'model',
      'instructionFiles',
      'projectAwareness',
      'sessionAwareness'
    ]) {
      expect(result, leak).not.toHaveProperty(leak)
    }
    // 对照：同一段 frontmatter 喂 agent 解析器 → 整份非法（这些键在那边才有语义）
    expect(parseAgentDefinitionFile(bot(...agentKeys), 'fn')).toBeNull()
  })

  it('BX-6 顶层裸键 pipeline / workflow / input / agents 被**静默忽略**（块里的才算数），零 warn', () => {
    // 风险钉板：从别家 YAML 迁移过来的人最可能写裸键。管线块本身必填（BR-8）兜住了「整份
    // 忘写」，但块外多写的裸键仍然静默 —— 用户以为生效的槽位表被丢掉，要到宿主对照管线
    // 提示「必填槽位没填」或跑起来才发现
    const { result, messages } = parseWithWarn(
      bot(
        'pipeline: other-flow',
        'workflow: other-flow',
        'input: { tone: terse }',
        'agents: { intent: x }'
      )
    )
    expect(result!.pipeline).toBe('bot-chat')
    expect(result!.pipelineInput).toEqual({})
    expect(result!.agents).toEqual({})
    expect(messages).toEqual([])
  })

  it.each([['shuvix-bot-Pipeline'], ['shuvix-bot_pipeline'], ['shuvix-bot-pipelines']])(
    'BX-7 顶层键拼错（%s）→ 等于没写管线块 → 整份拒绝（缺省没了，拼错反而能被发现）',
    (key) => {
      // 改制前拼错一个字母就静默回落成「跑 bot-chat、一个槽位都没填」；现在没有缺省，
      // 拼错的键是未知键、真键缺席 —— 拒绝理由直接把正确的键名写在脸上
      const msg = rejectReason(bare(`${key}:`, WF, AGENTS, '    intent: x'))
      expect(msg).toContain(`'${BOT_PIPELINE_KEY}' is required`)
    }
  )

  it.each([['Agents'], ['agent'], ['slots'], ['inputs']])(
    'BX-7b 块内子键拼错（%s）静默 → 槽位表 / 入参为空（拼错一个字母就静默成没填槽位）',
    (key) => {
      // 与顶层键不同，块内没有「必填」兜底（agents / input 本就可省略）—— 这一格靠宿主
      // 对照管线在属性卡上提示「必填槽位没填」来补
      const { result, messages } = parseWithWarn(withPipeline(WF, `  ${key}:`, '    intent: x'))
      expect(result, key).not.toBeNull()
      expect(result!.agents, key).toEqual({})
      expect(result!.pipelineInput, key).toEqual({})
      expect(messages, key).toEqual([])
    }
  )

  it('BX-8 旧的笔记分界线只是一行普通正文：逐字进 body，零 warn（笔记区这个概念不存在了）', () => {
    // 存量 bot 的正文里还留着 `<!-- shuvix:bot-notes -->`。它现在既不切分正文也不触发
    // 任何软告警 —— 人设和记忆是同一篇文档的不同段落，那条线读起来就是一条 HTML 注释
    const raw = md(
      '---',
      'description: d',
      ...pipelineBlock(),
      '---',
      'PERSONA',
      '',
      '<!-- shuvix:bot-notes -->',
      '',
      'old note line'
    )
    const { result, messages } = parseWithWarn(raw)
    expect(result).not.toBeNull()
    expect(messages).toEqual([])
    expect(result!.body).toBe(md('PERSONA', '', '<!-- shuvix:bot-notes -->', '', 'old note line'))
  })

  it('BX-9 管线块内的陌生子键忽略（同顶层未知键口径），零 warn、产物键集不变', () => {
    // 有人把 agent 键写进块里（model / tools），或把退役键挪了进来 —— 都只是没人读的键
    const { result, messages } = parseWithWarn(
      withPipeline(WF, '  model: gpt', '  tools: [read]', '  shuvix-bot-respond: sometimes')
    )
    expect(result).not.toBeNull()
    expect(messages).toEqual([])
    expect(result!.pipeline).toBe('my-flow')
    expect(Object.keys(result!).sort()).toEqual(PARSED_BOT_KEYS)
  })
})

// ────────────────────────────── BS：序列化 ──────────────────────────────

/** 全字段非缺省样本（BS 组的公共夹具） */
const FULL: ParsedBotFile = {
  name: 'reviewer-bot',
  displayName: '审查 bot',
  description: 'Reviews things: thoroughly, and with edge-cases.',
  body: 'You are a reviewer.\n\n- be thorough\n- cite lines\n\n## Learned\n\n- prefers pnpm',
  pipeline: 'my-pipeline',
  pipelineInput: { tone: 'terse' },
  // 槽位刻意乱序 + 混入管线之外的名字：BS-6 要证明写出去的是字母序
  agents: { task: 'my-task', intent: 'my-intent', recheck: 'my-recheck', gate: 'my-gate' }
}

/** frontmatter 的**顶层**键序（缩进行属于嵌套结构，不参与） */
const frontmatterKeys = (text: string): string[] =>
  text
    .split('\n---')[0]
    .split('\n')
    .slice(1)
    .filter((line) => line && !/^\s/.test(line))
    .map((line) => line.split(':')[0])

/** 管线块的直接子键序（恰两空格缩进的行） */
const pipelineSubKeys = (text: string): string[] =>
  text
    .split('\n---')[0]
    .split('\n')
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(':')[0])

describe('BS —— 序列化（与解析互逆）', () => {
  it('BS-1 全字段往返保真', () => {
    expect(parseBotDefinitionFile(serializeBotDefinitionFile(FULL), 'other-name')).toEqual(FULL)
  })

  it('BS-2 全字段覆盖守卫：接口加了字段却忘了序列化，这里先响', () => {
    expect(Object.keys(FULL).sort()).toEqual(PARSED_BOT_KEYS)
    // 解析产物的键集同样恒定
    expect(Object.keys(parseBotDefinitionFile(bot(), 'fn')!).sort()).toEqual(PARSED_BOT_KEYS)
  })

  it('BS-3 缺省值省略、管线块恒写：最小对象的序列化结果逐字固定；空正文时闭合 --- 之后什么都没有', () => {
    const minimal: ParsedBotFile = {
      name: 'minimal',
      displayName: 'minimal',
      description: 'd',
      body: 'body',
      pipeline: TEMPLATE_BOT_PIPELINE,
      pipelineInput: {},
      agents: {}
    }
    // agents / input 为空时省略子键，但 workflow 永远在 —— 它是必填，没有「等于缺省就省略」这回事
    expect(serializeBotDefinitionFile(minimal)).toBe(
      md(
        '---',
        'shuvix: bot v1',
        'name: minimal',
        'description: d',
        `${BOT_PIPELINE_KEY}:`,
        `  ${BOT_PIPELINE_WORKFLOW_KEY}: bot-chat`,
        '---',
        '',
        'body',
        ''
      )
    )
    // 空正文：不留一个孤零零的空行（新建 bot 的模板形态 —— 人设由用户写、记忆由 bot 写）
    expect(serializeBotDefinitionFile({ ...minimal, body: '' })).toBe(
      md(
        '---',
        'shuvix: bot v1',
        'name: minimal',
        'description: d',
        `${BOT_PIPELINE_KEY}:`,
        `  ${BOT_PIPELINE_WORKFLOW_KEY}: bot-chat`,
        '---',
        ''
      )
    )
  })

  it('BS-4 键序固定（属性卡与 diff 的可读性）：顶层 身份 → 管线块；块内 workflow → agents → input', () => {
    const text = serializeBotDefinitionFile(FULL)
    expect(frontmatterKeys(text)).toEqual([
      BOT_FILE_MARKER_KEY,
      'name',
      'description',
      'shuvix-displayName',
      BOT_PIPELINE_KEY
    ])
    expect(pipelineSubKeys(text)).toEqual([
      BOT_PIPELINE_WORKFLOW_KEY,
      BOT_PIPELINE_AGENTS_KEY,
      BOT_PIPELINE_INPUT_KEY
    ])
  })

  it('BS-5 文件类型标记恒写在首位', () => {
    expect(serializeBotDefinitionFile(FULL).split('\n')[1]).toBe(
      `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`
    )
  })

  it('BS-6 槽位键序恒为字母序（与对象插入序无关 —— 开放集合没有「阶段顺序」可依）', () => {
    // FULL 的插入序是 task → intent → recheck → gate，输出必须是 gate → intent → recheck → task；
    // 槽位行在块的第二层（四空格）
    expect(serializeBotDefinitionFile(FULL)).toContain(
      `  ${BOT_PIPELINE_AGENTS_KEY}:\n    gate: my-gate\n    intent: my-intent\n    recheck: my-recheck\n    task: my-task\n`
    )
    // 排序用 Array.sort() 的**码点序**，不是 localeCompare —— 大写槽位名排在小写之前。
    // 槽位名允许大写（ROLE_RE），所以这条是真实可达的形状；若将来改用 localeCompare，本例反转。
    const mixedCase = serializeBotDefinitionFile({ ...FULL, agents: { alpha: 'a', Zeta: 'z' } })
    expect(mixedCase).toContain(`  ${BOT_PIPELINE_AGENTS_KEY}:\n    Zeta: z\n    alpha: a\n`)
  })

  it.each([
    ['含裸冒号', 'Handles: everything'],
    ['含 # 号', 'tagged #1 issues'],
    ['以 * 起头（YAML alias 指示符）', '*starred value'],
    ['内含单引号', "o'brien's bot"],
    ['超长不折行', `long text ${'lorem ipsum '.repeat(30)}end`]
  ])(
    'BS-7 YAML 危险字符（%s）经引号转义后往返逐字相等（身份 / 工作流名 / 槽位值）',
    (_label, value) => {
      // 工作流名与 agent 名通常是标识符，但都接用户自取的名字 —— 块里的标量同样要设防
      const text = serializeBotDefinitionFile({
        ...FULL,
        description: value,
        displayName: value,
        pipeline: value,
        agents: { intent: value }
      })
      const parsed = parseBotDefinitionFile(text, 'x')!
      expect(parsed.description).toBe(value)
      expect(parsed.displayName).toBe(value)
      expect(parsed.pipeline).toBe(value)
      expect(parsed.agents.intent).toBe(value)
    }
  )

  it('BS-8 多行正文（含空行、--- 分隔线、代码块）往返保真', () => {
    const value: ParsedBotFile = {
      ...FULL,
      body: md('intro', '', '---', '', '```js', 'const x = 1', '```', '', 'outro')
    }
    expect(parseBotDefinitionFile(serializeBotDefinitionFile(value), 'x')).toEqual(value)
  })

  it('BS-9 序列化幂等（归一化只发生一次）', () => {
    const once = serializeBotDefinitionFile(FULL)
    const twice = serializeBotDefinitionFile(parseBotDefinitionFile(once, 'x')!)
    expect(twice).toBe(once)
  })

  it('BS-10 已知不对称：空 description 序列化出的文件解析不回来', () => {
    // serialize 不设防（空值省略键），产物少了必填键。当前写路径都先 parse 再落盘
    // （botService.parseForWrite 兜底），所以吃不到；GUI 若直接构造 ParsedBotFile
    // 保存就会静默产出坏文件。
    const text = serializeBotDefinitionFile({ ...FULL, description: '' })
    expect(text).not.toContain('description:')
    expect(rejectReason(text)).toContain("'description' is required")
  })

  it('BS-11 任意槽位名原样写回（开放表不设白名单，保存不得吃掉管线自定义的槽位）', () => {
    const agents = { intent: 'i', gate: 'g', reply: 'r', 'Ok-Role_2': 'o' }
    const text = serializeBotDefinitionFile({ ...FULL, agents })
    for (const [role, ref] of Object.entries(agents)) expect(text).toContain(`${role}: ${ref}`)
    expect(parseBotDefinitionFile(text, 'x')!.agents).toEqual(agents)
  })

  it('BS-12 正文两端的空白在**第一次**序列化时被归一（故它不是不动点，二次才是）', () => {
    // 序列化 trim 整篇正文、解析也 trim，所以带空白的入参写盘一次就变成 trim 过的值，之后恒定
    const padded: ParsedBotFile = { ...FULL, body: '\n\n  两端带空白  \n\n' }
    const once = serializeBotDefinitionFile(padded)
    const readBack = parseBotDefinitionFile(once, 'x')!
    expect(readBack.body).toBe('两端带空白')
    expect(readBack).not.toEqual(padded)
    expect(serializeBotDefinitionFile(readBack)).toBe(once)
  })

  it('BS-13 displayName 等于 name / 为空 / 纯空白 → 不写 shuvix-displayName，读回即 name', () => {
    for (const displayName of [FULL.name, '', '   ']) {
      const text = serializeBotDefinitionFile({ ...FULL, displayName })
      expect(text, JSON.stringify(displayName)).not.toContain('shuvix-displayName')
      expect(parseBotDefinitionFile(text, 'x')!.displayName, JSON.stringify(displayName)).toBe(
        FULL.name
      )
    }
  })

  it('BS-14 {{shuvix:*}} 占位符在正文里原样穿过序列化（替换归 createAgent）', () => {
    const value: ParsedBotFile = { ...FULL, body: 'Dir: {{shuvix:workingDirectory}}' }
    const text = serializeBotDefinitionFile(value)
    expect(text).toContain('{{shuvix:workingDirectory}}')
    expect(parseBotDefinitionFile(text, 'x')).toEqual(value)
  })

  it('BS-15 **调用点白名单：序列化器只服务「新建 bot」**', () => {
    // 它从固定键白名单重建 frontmatter，会丢注释、键序与未知键 —— **已存在的文件永远
    // 不该经过它**：日常维护由任务段 agent 用自己的文件工具就地改，用户的编辑由 save
    // 原样落盘。这条守卫在有人图省事用 serialize 实现 save 时先响。
    const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
    const sources: Array<{ path: string; text: string }> = []
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === '__tests__' || ent.name === 'dist') continue
        const full = join(dir, ent.name)
        if (ent.isDirectory()) walk(full)
        // 路径归一为 forward-slash：下面的 repoRoot 切片比较与 endsWith 都是 POSIX 字面量
        else if (/\.tsx?$/.test(ent.name))
          sources.push({ path: full.replace(/\\/g, '/'), text: readFileSync(full, 'utf-8') })
      }
    }
    walk(join(repoRoot, 'apps/desktop/src'))
    for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      try {
        walk(join(repoRoot, 'packages', pkg.name, 'src'))
      } catch {
        // 没有 src/ 的包（如 vendored 目录）跳过
      }
    }
    expect(sources.length).toBeGreaterThan(100)

    // 「调用点」= 出现 `serializeBotDefinitionFile(` 且不是它自己的函数声明
    const callers = sources
      .filter((s) =>
        s.text
          .split('\n')
          .some((l) => l.includes('serializeBotDefinitionFile(') && !l.includes('function '))
      )
      .map((s) => s.path.slice(repoRoot.length))
    expect(callers).toEqual(['apps/desktop/src/main/services/botService.ts'])

    const botService = sources.find((s) => s.path.endsWith('services/botService.ts'))!.text
    // 唯一调用点在「新建 bot」的模板生成里
    expect(botService).toMatch(/newBotTemplate\([\s\S]*?serializeBotDefinitionFile\(/)
    // 而 save 落的是调用方给的原文，不是 re-serialize 的产物
    expect(botService).toContain('writeFileAtomic(target.basePath, text)')
  })

  it('BS-16 旧形状永不写出：顶层没有 shuvix-bot-agents / shuvix-bot-input，管线键是纯键行而不是标量', () => {
    const text = serializeBotDefinitionFile(FULL)
    expect(text).not.toMatch(/^shuvix-bot-(agents|input):/m)
    expect(text).toMatch(new RegExp(`^${BOT_PIPELINE_KEY}:$`, 'm'))
    // 写出的文件不会撞上 BR-14 的退役键拒绝，也没有任何软告警
    expect(parseWithWarn(text).messages).toEqual([])
  })

  it('BS-17 已知不对称：空 pipeline 串序列化出的文件解析不回来（与 BS-10 同一种不设防）', () => {
    // 模板常量保证新建路径不会给空串；GUI 直接构造 ParsedBotFile 的话这里就是坏文件的来源
    const text = serializeBotDefinitionFile({ ...FULL, pipeline: '' })
    expect(text).toContain(`  ${BOT_PIPELINE_WORKFLOW_KEY}: ""`)
    expect(rejectReason(text)).toContain(
      `'${BOT_PIPELINE_KEY}.${BOT_PIPELINE_WORKFLOW_KEY}' must be the name of a workflow`
    )
  })
})

// ─────────────── BD：属性卡描述符（chat-protocol）与解析器的对齐 ───────────────

describe('BD —— 属性卡描述符与解析器的对齐', () => {
  const descriptor = SHUVIX_MD_DESCRIPTORS.find((d) => d.type === 'bot')!
  const cardKeys = descriptor.fields.map((f) => f.key)
  /**
   * 解析器实际读取的**顶层** frontmatter 键 / 管线块内的子键 —— 刻意写成字面量而不是引常量：
   * BD-4 / BD-5 要用它们反过来钉常量，两边都引常量就什么都钉不住
   */
  const parserKeys = ['name', 'description', 'shuvix-displayName', 'shuvix-bot-pipeline']
  const parserSubKeys = ['workflow', 'agents', 'input']
  const keysOf = (kind: string): string[] =>
    descriptor.fields
      .filter((f) => f.kind === kind)
      .map((f) => f.key)
      .sort()

  it('BD-1 描述符键 = 解析器读取的顶层键（agents / input 随管线块住进 botPipeline 字段，不再是顶层键）', () => {
    // 改制前解析器有而卡片无的恰是 agents / input 两个嵌套映射；现在它们是管线块的从属项，
    // 卡片上由 botPipeline 一个字段整块承接 —— 两份键集因此重合
    expect([...cardKeys].sort()).toEqual([...parserKeys].sort())
  })

  it('BD-2 卡片上没有 boolean / csv / list / select 字段：标量身份走 text / mono，管线块是唯一的 botPipeline', () => {
    // 改制前 notes 是 boolean、tools 是 csv、suggestions 是 list、respond 是 select；
    // 现在 bot 上只剩标量身份 + 一个可编辑的嵌套块
    for (const kind of ['boolean', 'csv', 'list', 'select']) {
      expect(keysOf(kind), kind).toEqual([])
    }
    expect(keysOf('botPipeline')).toEqual([BOT_PIPELINE_KEY])
    expect([...keysOf('text'), ...keysOf('mono'), ...keysOf('botPipeline')].sort()).toEqual(
      [...cardKeys].sort()
    )
  })

  it('BD-3 mono 键 = 标识符：只有 name；管线键是 botPipeline（解析器要它是映射，卡片按块渲染）', () => {
    expect(keysOf('mono')).toEqual(['name'])
    // 卡片的块控件建立在「值是映射」之上：标量形解析器拒绝，映射形读出 workflow
    expect(parseBotDefinitionFile(bare(`${BOT_PIPELINE_KEY}: my-flow`), 'x')).toBeNull()
    expect(parseBotDefinitionFile(withPipeline(WF), 'x')!.pipeline).toBe('my-flow')
  })

  it('BD-4 键常量的单一真源在 chat-protocol：botFile 转出口的四个常量与之全等，且字面值就是文件里的写法', () => {
    // 渲染进程够不到 agent-runtime，属性卡按 chat-protocol 那份改 md（patchFrontmatterPath）；
    // botFile.ts 只转出口，不另存一份 —— 漂移在类型上就不可能，这里钉的是字面值：
    // 改常量 = 改文件格式，用户文件里写的是这些串
    expect(BOT_PIPELINE_KEY).toBe(PROTOCOL_PIPELINE_KEY)
    expect(BOT_PIPELINE_WORKFLOW_KEY).toBe(PROTOCOL_WORKFLOW_KEY)
    expect(BOT_PIPELINE_AGENTS_KEY).toBe(PROTOCOL_AGENTS_KEY)
    expect(BOT_PIPELINE_INPUT_KEY).toBe(PROTOCOL_INPUT_KEY)
    expect(BOT_PIPELINE_KEY).toBe('shuvix-bot-pipeline')
    expect(BOT_PIPELINE_WORKFLOW_KEY).toBe('workflow')
    expect(BOT_PIPELINE_AGENTS_KEY).toBe('agents')
    expect(BOT_PIPELINE_INPUT_KEY).toBe('input')
  })

  it('BD-5 弱守卫：chat-protocol 声明的每个 BOT_*_KEY 都在解析器读取的键集里；botFile.ts 自己不再声明任何 BOT_*_KEY', () => {
    // 上面的 parserKeys / parserSubKeys 是手维护清单，加了新键却忘了补它，BD-1 就会静默失真。
    // 这条从源码里抓键常量，让漏补先在这里响。
    const protocolSource = readFileSync(
      fileURLToPath(
        new URL('../../../../chat-protocol/src/shuvixMdDescriptors.ts', import.meta.url)
      ),
      'utf-8'
    )
    const declared = [...protocolSource.matchAll(/export const (BOT_\w*_KEY) = '([^']+)'/g)]
    // 顶层键 + 三个子键；再多出一个就是有新键要补进清单
    expect(declared.map(([, constName]) => constName).sort()).toEqual([
      'BOT_PIPELINE_AGENTS_KEY',
      'BOT_PIPELINE_INPUT_KEY',
      'BOT_PIPELINE_KEY',
      'BOT_PIPELINE_WORKFLOW_KEY'
    ])
    for (const [, constName, key] of declared) {
      const known = constName === 'BOT_PIPELINE_KEY' ? parserKeys : parserSubKeys
      expect(known, constName).toContain(key)
    }
    // botFile.ts 只剩文件类型标记键是自己声明的 —— 键常量若在这里再声明一份，就是第二个真源
    const botFileSource = readFileSync(
      fileURLToPath(new URL('../botFile.ts', import.meta.url)),
      'utf-8'
    )
    const local = [...botFileSource.matchAll(/export const (BOT_\w*_KEY) = '([^']+)'/g)].map(
      ([, constName]) => constName
    )
    expect(local).toEqual(['BOT_FILE_MARKER_KEY'])
  })
})
