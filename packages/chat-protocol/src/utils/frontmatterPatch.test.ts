/**
 * patchFrontmatterScalar —— 设置页「门控模型选择器」的唯一写入原语（A1）。
 *
 * 它对 ~/.shuvix/agents/bot-intent.md 这样的**既有用户文件**做单键改写，所以这组测试
 * 钉的是「除目标行外逐字节不动」这条纪律：它一旦破坏注释/键序/正文，用户手编的覆盖
 * 档案就会在一次改模型之后面目全非。
 *
 * **钉现状，不改实现**（A 组约定）。读实现时发现的两处隐患记录在此，供后续裁决：
 *  - `new RegExp(\`^${key}\\s*:\`)` 把 key 原样拼进正则 —— key 含正则元字符时会错配。
 *    现有调用方只传 'shuvix-model'，暂无触发面；
 *  - frontmatter 键重复时只动第一处（见 A9 的注释）。
 */
import { describe, it, expect } from 'vitest'
import {
  patchFrontmatterMappingEntry,
  patchFrontmatterPath,
  patchFrontmatterPaths,
  patchFrontmatterScalar,
  type FrontmatterPathEdit
} from './frontmatterPatch'

/** 一份典型的 bot-intent 覆盖档案（含注释与正文 —— 它们必须原样活过改写） */
const DOC = [
  '---',
  'shuvix: agent v1',
  'name: bot-intent',
  'description: gate stage',
  'shuvix-model: openai/gpt-old',
  'shuvix-session-awareness: true',
  '---',
  '',
  'BODY LINE ONE.',
  'BODY LINE TWO.'
].join('\n')

describe('patchFrontmatterScalar', () => {
  it('A1 改既有键：仅该行变，其余逐字节不变', () => {
    const out = patchFrontmatterScalar(DOC, 'shuvix-model', 'openai/gpt-4.1')
    expect(out).toBe(DOC.replace('shuvix-model: openai/gpt-old', 'shuvix-model: openai/gpt-4.1'))
    // 行数不变（原位替换，不是删了再插）
    expect(out.split('\n')).toHaveLength(DOC.split('\n').length)
  })

  it('A2 冒号前带空格的 `key : old` 命中，并替换为规范形 `key: new`', () => {
    const text = ['---', 'name: x', 'shuvix-model : old-ref', '---', 'BODY.'].join('\n')
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'new-ref')).toBe(
      ['---', 'name: x', 'shuvix-model: new-ref', '---', 'BODY.'].join('\n')
    )
  })

  it('A3 近似前缀键 shuvix-model-extra 不误伤 —— 插入新行而不是改它', () => {
    const text = ['---', 'name: x', 'shuvix-model-extra: keep-me', '---', 'BODY.'].join('\n')
    const out = patchFrontmatterScalar(text, 'shuvix-model', 'v1')
    // 近似键原样保留
    expect(out).toContain('shuvix-model-extra: keep-me')
    // 目标键作为新行插进闭合 --- 之前
    expect(out).toBe(
      ['---', 'name: x', 'shuvix-model-extra: keep-me', 'shuvix-model: v1', '---', 'BODY.'].join(
        '\n'
      )
    )
  })

  it('A4 键缺失 → 恰在闭合 --- 前一行插入，body 一字不动', () => {
    const text = ['---', 'name: x', '---', '', 'BODY KEEPS EXACTLY.', ''].join('\n')
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'p/m')).toBe(
      ['---', 'name: x', 'shuvix-model: p/m', '---', '', 'BODY KEEPS EXACTLY.', ''].join('\n')
    )
  })

  it('A5 删除既有键：该行整行消失，其余不动', () => {
    expect(patchFrontmatterScalar(DOC, 'shuvix-model', null)).toBe(
      DOC.split('\n')
        .filter((l) => l !== 'shuvix-model: openai/gpt-old')
        .join('\n')
    )
  })

  it('A5b 删除不存在的键 → 原文返回', () => {
    const text = ['---', 'name: x', '---', 'BODY.'].join('\n')
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(text)
  })

  it('A6 无 frontmatter（首行非 ---）→ set / delete 均原样返回', () => {
    const text = 'just prose\n---\nnot frontmatter\n---\n'
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'v')).toBe(text)
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(text)
  })

  it('A6b 首行是空行、--- 在第二行 → 不算 frontmatter，原样返回', () => {
    // 判定只认第 0 行（与 markdownFrontmatter 的严格口径同向）：领头空行即散文
    const text = '\n---\nshuvix-model: old\n---\nBODY.'
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'new')).toBe(text)
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(text)
  })

  it('A7 只有开头 --- 没有闭合 → 原样返回（不猜块边界）', () => {
    const text = '---\nname: x\nshuvix-model: old\nBODY WITHOUT CLOSE.'
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'new')).toBe(text)
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(text)
  })

  it('A8 空 frontmatter 块 → 插入恰落在两条 --- 之间', () => {
    expect(patchFrontmatterScalar('---\n---\nBODY.', 'shuvix-model', 'p/m')).toBe(
      '---\nshuvix-model: p/m\n---\nBODY.'
    )
  })

  it('A9 键重复两次：set 改第一处留第二处；delete 删第一处留第二处（钉现状）', () => {
    // ⚠️ 钉的是现状，不是背书：YAML 语义下重复键以**后者**为准（yaml 库甚至直接报错），
    // 而本函数只动**第一处** —— set 之后生效值仍是第二处的旧值，delete 之后第二处「复活」。
    // 真实调用链里这种文件本就过不了 parseAgentDefinitionFile，风险面有限；若将来
    // 改成「动最后一处 / 全部」，这条用例就是要一起改的那条。
    const text = ['---', 'shuvix-model: first', 'name: x', 'shuvix-model: second', '---', 'B'].join(
      '\n'
    )
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'patched')).toBe(
      ['---', 'shuvix-model: patched', 'name: x', 'shuvix-model: second', '---', 'B'].join('\n')
    )
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(
      ['---', 'name: x', 'shuvix-model: second', '---', 'B'].join('\n')
    )
  })

  it('A10 正文里的同名键与正文 ---（hr）不受影响（i < close 的边界）', () => {
    const text = [
      '---',
      'name: x',
      'shuvix-model: fm-value',
      '---',
      '',
      'shuvix-model: body-value',
      '',
      '---',
      '',
      'after the hr.'
    ].join('\n')
    const out = patchFrontmatterScalar(text, 'shuvix-model', 'patched')
    expect(out).toBe(
      [
        '---',
        'name: x',
        'shuvix-model: patched',
        '---',
        '',
        'shuvix-model: body-value',
        '',
        '---',
        '',
        'after the hr.'
      ].join('\n')
    )
    // 删除同理只动 frontmatter 里那行
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(
      text
        .split('\n')
        .filter((l) => l !== 'shuvix-model: fm-value')
        .join('\n')
    )
  })

  it('A11 缩进的嵌套同名键不命中（^ 锚定）→ 插入顶层行', () => {
    const text = [
      '---',
      'shuvix-bot-agents:',
      '  intent: bot-intent',
      '  model: nested-keep',
      '---',
      'B'
    ].join('\n')
    const out = patchFrontmatterScalar(text, 'model', 'top-level')
    expect(out).toContain('  model: nested-keep')
    expect(out).toBe(
      [
        '---',
        'shuvix-bot-agents:',
        '  intent: bot-intent',
        '  model: nested-keep',
        'model: top-level',
        '---',
        'B'
      ].join('\n')
    )
  })

  it('A12 值原样写入：`key: value` 单空格，无引号无转义', () => {
    const out = patchFrontmatterScalar('---\n---\n', 'shuvix-model', 'openai/gpt-4.1')
    expect(out.split('\n')[1]).toBe('shuvix-model: openai/gpt-4.1')
  })

  it('A13 CRLF：`---\\r\\n` 与 `key: v\\r` 都可识别；改写行落 LF（钉混合行尾现状）', () => {
    const text = '---\r\nname: x\r\nshuvix-model: old\r\n---\r\nBODY\r\n'
    // 识别：CRLF 的 --- 与键行都命中（trim / \s* 吃掉 \r）
    const out = patchFrontmatterScalar(text, 'shuvix-model', 'openai/gpt-4.1')
    // ⚠️ 现状：替换行是重铸的 `key: value`，**不带 \r** —— 输出因此是混合行尾。
    // md 解析两种行尾都认，这里如实钉住，若将来改为保留原行尾需同步改此断言
    expect(out).toBe('---\r\nname: x\r\nshuvix-model: openai/gpt-4.1\n---\r\nBODY\r\n')
    // 删除：整行（连同它的 \r）消失
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(
      '---\r\nname: x\r\n---\r\nBODY\r\n'
    )
    // 插入：新行同样是 LF 尾（与替换同一条纪律）
    expect(patchFrontmatterScalar('---\r\nname: x\r\n---\r\nB\r\n', 'shuvix-model', 'm')).toBe(
      '---\r\nname: x\r\nshuvix-model: m\n---\r\nB\r\n'
    )
  })
})

/**
 * patchFrontmatterMappingEntry —— 改/删一层嵌套映射的一条 `  条目: 值`（改制前 bot md 的
 * `shuvix-bot-agents:` 块就是这种形状；管线块改制成三层之后，属性卡走的是下面的
 * patchFrontmatterPath，这个原语原样保留、用例也原样钉住）。与 patchFrontmatterScalar
 * 同一条纪律（块外的行逐字节不动），差别在它动的是一个**嵌套块**：块从解析出的条目重建。
 *
 * **钉现状，不改实现**。读实现时发现的两处隐患记录在此，供后续裁决（M6 / M9 各钉一条）：
 *  - 流式写法 `key: { a: b }` 整行替换成块时，流式里原有的条目**不被读出**——会丢；
 *  - 块内的缩进注释与空行随重建消失（只有 `entry: value` 行活下来）。
 */
describe('patchFrontmatterMappingEntry', () => {
  const KEY = 'shuvix-bot-agents'
  /** 一份典型的 bot md（含块外注释、其它键与正文 —— 它们必须原样活过改写） */
  const BOT = [
    '---',
    'shuvix: bot v1',
    'name: scout',
    '# who I am',
    'description: scouts code',
    `${KEY}:`,
    '  intent: bot-intent',
    '  task: default',
    'shuvix-bot-pipeline: bot-chat',
    '---',
    '',
    'PERSONA.',
    ''
  ].join('\n')

  it('M1 既有块加一条：追加在块尾，其余行逐字节不变', () => {
    expect(patchFrontmatterMappingEntry(BOT, KEY, 'recheck', 'reviewer')).toBe(
      BOT.replace('  task: default\n', '  task: default\n  recheck: reviewer\n')
    )
  })

  it('M2 改既有条：原位替换，其它条目 / 块外注释 / 键序 / 正文不动', () => {
    const out = patchFrontmatterMappingEntry(BOT, KEY, 'task', 'coding')
    expect(out).toBe(BOT.replace('  task: default', '  task: coding'))
    // 行数不变（原位替换，不是删了再插）
    expect(out.split('\n')).toHaveLength(BOT.split('\n').length)
  })

  it('M3 键缺失 → 在闭合 --- 之前新起一块；近似前缀键 shuvix-bot-agents-extra 不误伤', () => {
    const text = ['---', 'name: x', `${KEY}-extra:`, '  keep: me', '---', 'BODY.'].join('\n')
    expect(patchFrontmatterMappingEntry(text, KEY, 'intent', 'bot-intent')).toBe(
      [
        '---',
        'name: x',
        `${KEY}-extra:`,
        '  keep: me',
        `${KEY}:`,
        '  intent: bot-intent',
        '---',
        'BODY.'
      ].join('\n')
    )
  })

  it('M4 删一条：该行消失，其余条目留下', () => {
    expect(patchFrontmatterMappingEntry(BOT, KEY, 'intent', null)).toBe(
      BOT.replace('  intent: bot-intent\n', '')
    )
  })

  it('M5 删到块空 → 连 `key:` 那一行一起删（不留一个值为 null 的裸键）', () => {
    // 留下裸 `shuvix-bot-agents:` 在 YAML 里是 null —— 解析侧把它当省略，但文件读起来像没写完
    const one = [
      '---',
      'name: x',
      `${KEY}:`,
      '  task: default',
      'shuvix-bot-pipeline: bot-chat',
      '---',
      'B'
    ]
    expect(patchFrontmatterMappingEntry(one.join('\n'), KEY, 'task', null)).toBe(
      ['---', 'name: x', 'shuvix-bot-pipeline: bot-chat', '---', 'B'].join('\n')
    )
  })

  it('M6 流式写法 `key: { … }` 整行替换成块（⚠️ 钉现状：流式里原有的条目不被读出，会丢）', () => {
    // 用户手写 `shuvix-bot-agents: { intent: bot-intent, task: default }` 后在设置页改一个
    // 下拉，intent / task 会随这次改写消失 —— 解析器接着报「缺必填槽位」。流式写法在
    // 新建模板与序列化器里都不会出现（它们写块），所以触发面是手写文件；值得改，先钉住
    const flow = ['---', 'name: x', `${KEY}: { intent: bot-intent, task: default }`, '---', 'B']
    expect(patchFrontmatterMappingEntry(flow.join('\n'), KEY, 'recheck', 'reviewer')).toBe(
      ['---', 'name: x', `${KEY}:`, '  recheck: reviewer', '---', 'B'].join('\n')
    )
    // 删除同理：整行流式映射被当成空块删掉
    expect(patchFrontmatterMappingEntry(flow.join('\n'), KEY, 'task', null)).toBe(
      ['---', 'name: x', '---', 'B'].join('\n')
    )
  })

  it('M7 无 frontmatter / 只有开头 --- 没有闭合 / 删不存在的条 → 原样返回', () => {
    const noFm = 'just prose\n---\nnot frontmatter\n---\n'
    expect(patchFrontmatterMappingEntry(noFm, KEY, 'task', 'x')).toBe(noFm)
    const unclosed = `---\nname: x\n${KEY}:\n  task: default\nBODY WITHOUT CLOSE.`
    expect(patchFrontmatterMappingEntry(unclosed, KEY, 'task', 'x')).toBe(unclosed)
    // 删不存在的条（块在 / 块不在）都是无操作
    expect(patchFrontmatterMappingEntry(BOT, KEY, 'ghost', null)).toBe(BOT)
    const noKey = ['---', 'name: x', '---', 'B'].join('\n')
    expect(patchFrontmatterMappingEntry(noKey, KEY, 'task', null)).toBe(noKey)
  })

  it('M8 正文里的同名块与正文 ---（hr）不受影响（i < close 的边界）', () => {
    const text = [
      '---',
      'name: x',
      `${KEY}:`,
      '  task: fm-value',
      '---',
      '',
      `${KEY}:`,
      '  task: body-value',
      '',
      '---',
      '',
      'after the hr.'
    ].join('\n')
    expect(patchFrontmatterMappingEntry(text, KEY, 'task', 'patched')).toBe(
      text.replace('  task: fm-value', '  task: patched')
    )
    expect(patchFrontmatterMappingEntry(text, KEY, 'task', null)).toBe(
      text.replace(`${KEY}:\n  task: fm-value\n`, '')
    )
  })

  it('M9 块从条目重建（⚠️ 钉现状）：块内缩进注释与空行消失，缩进归一为两空格', () => {
    // 与 A13 同一种「如实钉住」：md 解析两种写法都认，改写只保证条目语义不变；若将来改成
    // 逐行原位改写以保住块内注释，本例反转
    const text = [
      '---',
      'name: x',
      `${KEY}:`,
      '    # the gate',
      '    intent: bot-intent',
      '',
      '    task: default',
      'shuvix-bot-pipeline: bot-chat',
      '---',
      'B'
    ].join('\n')
    expect(patchFrontmatterMappingEntry(text, KEY, 'task', 'coding')).toBe(
      [
        '---',
        'name: x',
        `${KEY}:`,
        '  intent: bot-intent',
        '  task: coding',
        'shuvix-bot-pipeline: bot-chat',
        '---',
        'B'
      ].join('\n')
    )
  })
})

/**
 * patchFrontmatterPath / patchFrontmatterPaths —— 属性卡 bot 管线块（`botPipeline` 字段）的
 * 唯一写入原语：按路径改/删 `shuvix-bot-pipeline.workflow` / `shuvix-bot-pipeline.agents.<槽位>`。
 *
 * 与前两个原语同一条纪律（目标行之外逐字节不动），但它是**行级原位改写**而不是块重建：
 * 块内注释、空行、缩进风格都活下来 —— M6 / M9 钉住的两处丢失在这里反转（P1 / P8）。
 * 换工作流 = 改 workflow + 删旧槽位 + 填新槽位，要落成**一次**文档变更，所以有 `patchFrontmatterPaths`。
 *
 * ⚠️ 钉现状的几处（P6b / P11 / P17）：块内只剩注释时父键保留、CRLF 文件改写行落 LF、
 * 目标行整行重铸。它们都不是设计承诺，改了实现就改这里。
 */
describe('patchFrontmatterPath / patchFrontmatterPaths', () => {
  const KEY = 'shuvix-bot-pipeline'
  /** 路径都从管线键起 */
  const at = (...rest: string[]): string[] => [KEY, ...rest]

  /** 一份典型的新形状 bot md：三层块（管线 → 槽位表 → 条目）+ 块内注释 + 块外注释 + 正文 */
  const DOC = [
    '---',
    'shuvix: bot v1',
    'name: scout',
    '# who I am',
    'description: scouts code',
    `${KEY}:`,
    '  workflow: bot-chat',
    '  # the slots',
    '  agents:',
    '    intent: bot-intent',
    '    task: default',
    '  input:',
    '    tone: terse',
    '---',
    '',
    'PERSONA.',
    ''
  ].join('\n')

  it('P1 改三层块里的既有条目：仅该行变，块内注释 / 其它条目 / 键序 / 正文逐字节不变', () => {
    const out = patchFrontmatterPath(DOC, at('agents', 'task'), 'coding')
    expect(out).toBe(DOC.replace('    task: default', '    task: coding'))
    // 行数不变（原位替换，不是删了再插）
    expect(out.split('\n')).toHaveLength(DOC.split('\n').length)
    // 两层路径同理：换工作流只动 workflow 那一行
    expect(patchFrontmatterPath(DOC, at('workflow'), 'my-flow')).toBe(
      DOC.replace('  workflow: bot-chat', '  workflow: my-flow')
    )
  })

  it('P2 该层没有的条目追加在**该层块尾**（task 之后、input 之前），缩进沿用同层已有子行', () => {
    expect(patchFrontmatterPath(DOC, at('agents', 'recheck'), 'reviewer')).toBe(
      DOC.replace('    task: default\n', '    task: default\n    recheck: reviewer\n')
    )
  })

  it('P3 中间层缺失就地创建在父块块尾：没有 agents: 的管线块长出 agents 及其条目', () => {
    const noAgents = [
      '---',
      'name: x',
      `${KEY}:`,
      '  workflow: bot-chat',
      '  input:',
      '    tone: terse',
      '---',
      'B'
    ].join('\n')
    expect(patchFrontmatterPath(noAgents, at('agents', 'intent'), 'bot-intent')).toBe(
      [
        '---',
        'name: x',
        `${KEY}:`,
        '  workflow: bot-chat',
        '  input:',
        '    tone: terse',
        '  agents:',
        '    intent: bot-intent',
        '---',
        'B'
      ].join('\n')
    )
  })

  it('P4 顶层键缺失 → 整条路径逐层新建，插在闭合 --- 之前；正文一字不动', () => {
    const noKey = ['---', 'name: x', '---', '', 'BODY KEEPS EXACTLY.', ''].join('\n')
    expect(patchFrontmatterPath(noKey, at('workflow'), 'bot-chat')).toBe(
      [
        '---',
        'name: x',
        `${KEY}:`,
        '  workflow: bot-chat',
        '---',
        '',
        'BODY KEEPS EXACTLY.',
        ''
      ].join('\n')
    )
    // 三层路径：三行全新建，缩进逐层 + 2
    expect(patchFrontmatterPath(noKey, at('agents', 'intent'), 'bot-intent')).toBe(
      [
        '---',
        'name: x',
        `${KEY}:`,
        '  agents:',
        '    intent: bot-intent',
        '---',
        '',
        'BODY KEEPS EXACTLY.',
        ''
      ].join('\n')
    )
    // 空 frontmatter 块 → 插入恰落在两条 --- 之间
    expect(patchFrontmatterPath('---\n---\nBODY.', at('workflow'), 'bot-chat')).toBe(
      `---\n${KEY}:\n  workflow: bot-chat\n---\nBODY.`
    )
  })

  it('P5 删一条槽位：该行消失，同层其余条目与父键留下', () => {
    expect(patchFrontmatterPath(DOC, at('agents', 'intent'), null)).toBe(
      DOC.replace('    intent: bot-intent\n', '')
    )
  })

  it('P6 删到某层块空时连它的键行一起删，逐层向上：agents 的最后一条走了 agents: 也走；管线块空了顶层键也走', () => {
    // 只剩一条槽位：删它 → `agents:` 一起消失，workflow 留下，块还在
    const oneSlot = [
      '---',
      'name: x',
      `${KEY}:`,
      '  workflow: bot-chat',
      '  agents:',
      '    task: default',
      '---',
      'B'
    ].join('\n')
    expect(patchFrontmatterPath(oneSlot, at('agents', 'task'), null)).toBe(
      ['---', 'name: x', `${KEY}:`, '  workflow: bot-chat', '---', 'B'].join('\n')
    )
    // 块里只有 agents 一条槽位：删它 → agents: 与顶层键一起消失，不留值为 null 的裸键
    const onlyAgents = ['---', 'name: x', `${KEY}:`, '  agents:', '    task: default', '---', 'B']
    expect(patchFrontmatterPath(onlyAgents.join('\n'), at('agents', 'task'), null)).toBe(
      ['---', 'name: x', '---', 'B'].join('\n')
    )
    // 两层路径同理：删 workflow 后块空，顶层键走
    const onlyWf = ['---', 'name: x', `${KEY}:`, '  workflow: bot-chat', '---', 'B']
    expect(patchFrontmatterPath(onlyWf.join('\n'), at('workflow'), null)).toBe(
      ['---', 'name: x', '---', 'B'].join('\n')
    )
  })

  it('P6b ⚠️ 钉现状：块内只剩缩进注释时父键行保留（注释是用户的话，不替他删）—— 留下的是一个值为 null 的 agents:', () => {
    // 解析侧把 `agents:`（null）当省略，所以文件仍合法；若将来改成「只剩注释也算空」，本例反转
    const commented = [
      '---',
      'name: x',
      `${KEY}:`,
      '  workflow: bot-chat',
      '  agents:',
      '    # the gate',
      '    intent: bot-intent',
      '---',
      'B'
    ].join('\n')
    expect(patchFrontmatterPath(commented, at('agents', 'intent'), null)).toBe(
      [
        '---',
        'name: x',
        `${KEY}:`,
        '  workflow: bot-chat',
        '  agents:',
        '    # the gate',
        '---',
        'B'
      ].join('\n')
    )
  })

  it('P7 删本就不存在的条目 → 原文返回：叶子缺 / 中间层缺 / 顶层键缺，三种都无事发生', () => {
    expect(patchFrontmatterPath(DOC, at('agents', 'ghost'), null)).toBe(DOC)
    expect(patchFrontmatterPath(DOC, at('limits', 'maxAgents'), null)).toBe(DOC)
    const noKey = ['---', 'name: x', '---', 'B'].join('\n')
    expect(patchFrontmatterPath(noKey, at('agents', 'task'), null)).toBe(noKey)
  })

  it('P8 父键行是流式映射 `agents: { intent: x, task: y }` → 先摊成块再改，流式里原有的条目**逐条保留**（M6 的丢失在此反转）', () => {
    const flow = [
      '---',
      'name: x',
      `${KEY}:`,
      '  workflow: bot-chat',
      '  agents: { intent: bot-intent, task: default }',
      '---',
      'B'
    ].join('\n')
    expect(patchFrontmatterPath(flow, at('agents', 'task'), 'coding')).toBe(
      [
        '---',
        'name: x',
        `${KEY}:`,
        '  workflow: bot-chat',
        '  agents:',
        '    intent: bot-intent',
        '    task: coding',
        '---',
        'B'
      ].join('\n')
    )
    // 删除同理：摊开之后只删那一条，另一条活下来
    expect(patchFrontmatterPath(flow, at('agents', 'intent'), null)).toBe(
      [
        '---',
        'name: x',
        `${KEY}:`,
        '  workflow: bot-chat',
        '  agents:',
        '    task: default',
        '---',
        'B'
      ].join('\n')
    )
    // 空流式 `{}` 摊成只有新条目的块
    const empty = ['---', 'name: x', `${KEY}:`, '  agents: {}', '---', 'B'].join('\n')
    expect(patchFrontmatterPath(empty, at('agents', 'intent'), 'i')).toBe(
      ['---', 'name: x', `${KEY}:`, '  agents:', '    intent: i', '---', 'B'].join('\n')
    )
    // 含嵌套括号的流式值不猜：原样返回、什么都不改
    const nested = ['---', 'name: x', `${KEY}: { agents: { intent: i } }`, '---', 'B'].join('\n')
    expect(patchFrontmatterPath(nested, at('agents', 'task'), 'coding')).toBe(nested)
  })

  it('P9 父键行带标量值（改制前的 `shuvix-bot-pipeline: bot-chat`）→ 标量让位给块；旧值**不**自动搬进 workflow，写什么由调用方说', () => {
    const legacy = ['---', 'name: x', `${KEY}: bot-chat`, '---', 'B'].join('\n')
    expect(patchFrontmatterPath(legacy, at('workflow'), 'bot-chat')).toBe(
      ['---', 'name: x', `${KEY}:`, '  workflow: bot-chat', '---', 'B'].join('\n')
    )
    // 三层路径同理：标量行变纯键行，下面长出两层 —— 旧的管线名就此消失（调用方要保它得自己再设一条）
    expect(patchFrontmatterPath(legacy, at('agents', 'intent'), 'bot-intent')).toBe(
      ['---', 'name: x', `${KEY}:`, '  agents:', '    intent: bot-intent', '---', 'B'].join('\n')
    )
  })

  it('P10 缩进沿用该层已有子行（四空格文件追加四空格）；新起一层时它的子行沿用文件的缩进单位', () => {
    const four = [
      '---',
      'name: x',
      `${KEY}:`,
      '    workflow: bot-chat',
      '    agents:',
      '        intent: bot-intent',
      '---',
      'B'
    ].join('\n')
    expect(patchFrontmatterPath(four, at('agents', 'task'), 'default')).toBe(
      [
        '---',
        'name: x',
        `${KEY}:`,
        '    workflow: bot-chat',
        '    agents:',
        '        intent: bot-intent',
        '        task: default',
        '---',
        'B'
      ].join('\n')
    )
    // 新起一层 input：与同层的 workflow / agents 对齐（四空格）；它自己的子行没有先例可循，
    // 取文件的缩进单位（frontmatter 里第一条缩进行 = 四空格）落成八空格，与整份文件一个风格
    expect(patchFrontmatterPath(four, at('input', 'tone'), 'terse')).toBe(
      [
        '---',
        'name: x',
        `${KEY}:`,
        '    workflow: bot-chat',
        '    agents:',
        '        intent: bot-intent',
        '    input:',
        '        tone: terse',
        '---',
        'B'
      ].join('\n')
    )
  })

  it('P11 CRLF：`---\\r\\n` 与 `key:\\r` / `key: v\\r` 都可识别；改写行落 LF（与 A13 同一条钉混合行尾的现状）', () => {
    const text = `---\r\nname: x\r\n${KEY}:\r\n  workflow: old\r\n---\r\nBODY\r\n`
    expect(patchFrontmatterPath(text, at('workflow'), 'new')).toBe(
      `---\r\nname: x\r\n${KEY}:\r\n  workflow: new\n---\r\nBODY\r\n`
    )
    // 删除：整行连同它的 \r 消失，块空则纯键行（`key:\r`）也走
    expect(patchFrontmatterPath(text, at('workflow'), null)).toBe(
      '---\r\nname: x\r\n---\r\nBODY\r\n'
    )
    // 追加：新行同样 LF 尾
    expect(patchFrontmatterPath(text, at('agents', 'intent'), 'i')).toBe(
      `---\r\nname: x\r\n${KEY}:\r\n  workflow: old\r\n  agents:\n    intent: i\n---\r\nBODY\r\n`
    )
  })

  it.each([
    ['含 `: `', 'Handles: everything', "'Handles: everything'"],
    ['含 ` #`', 'tagged #1 issues', "'tagged #1 issues'"],
    ['以 * 起头（alias 指示符）', '*starred', "'*starred'"],
    ['以 - 起头（序列指示符）', '-dash', "'-dash'"],
    ['以引号起头', '"quoted"', `'"quoted"'`],
    ['危险取值里的单引号加倍', "it's: fine", "'it''s: fine'"],
    ['首尾空白', ' padded ', "' padded '"],
    ['以冒号收尾', 'trailing:', "'trailing:'"],
    ['空串', '', "''"]
  ])('P12 YAML 危险取值（%s）加单引号写出', (_label, value, expected) => {
    expect(patchFrontmatterPath(DOC, at('agents', 'task'), value)).toContain(
      `    task: ${expected}\n`
    )
  })

  it('P12b 普通标识符原样写出，不加引号（工作流名 / agent 名 / 带斜杠的模型 ref / 内含单引号都不算危险）', () => {
    for (const v of ['bot-chat', 'my_flow.v2', 'openai/gpt-4.1', 'Ok-Role_2', "o'brien"]) {
      expect(patchFrontmatterPath(DOC, at('workflow'), v), v).toContain(`  workflow: ${v}\n`)
    }
  })

  it('P13 patchFrontmatterPaths 依次应用、落成一份文本：换工作流 = 改 workflow + 填新槽位 + 删旧槽位', () => {
    const edits: FrontmatterPathEdit[] = [
      { path: at('workflow'), value: 'my-flow' },
      { path: at('agents', 'worker'), value: 'coding' },
      { path: at('agents', 'intent'), value: null },
      { path: at('agents', 'task'), value: null }
    ]
    const out = patchFrontmatterPaths(DOC, edits)
    expect(out).toBe(edits.reduce((acc, e) => patchFrontmatterPath(acc, e.path, e.value), DOC))
    expect(out).toBe(
      DOC.replace('  workflow: bot-chat', '  workflow: my-flow').replace(
        '    intent: bot-intent\n    task: default\n',
        '    worker: coding\n'
      )
    )
    // 空批 → 原文（同一引用语义不作承诺，逐字相等即可）
    expect(patchFrontmatterPaths(DOC, [])).toBe(DOC)
  })

  it('P13b 顺序即语义：先删空再填 → agents 块被级联删掉后在管线块**尾部**重建（属性卡要保块位就先填后删）', () => {
    // 先设后删 = 没有；先删后设 = 有
    const set = { path: at('agents', 'recheck'), value: 'r' }
    const del = { path: at('agents', 'recheck'), value: null }
    expect(patchFrontmatterPaths(DOC, [set, del])).toBe(DOC)
    expect(patchFrontmatterPaths(DOC, [del, set])).toContain('    recheck: r\n')
    // 两条槽位都删完再填新的：中途 agents: 随 P6 的级联消失，新槽位让它在块尾（input 之后）重生
    const out = patchFrontmatterPaths(DOC, [
      { path: at('agents', 'intent'), value: null },
      { path: at('agents', 'task'), value: null },
      { path: at('agents', 'worker'), value: 'coding' }
    ])
    expect(out).toBe(
      DOC.replace('  agents:\n    intent: bot-intent\n    task: default\n', '').replace(
        '    tone: terse\n',
        '    tone: terse\n  agents:\n    worker: coding\n'
      )
    )
  })

  it('P14 无 frontmatter / 只有开头 --- 没有闭合 / 路径为空 / 首行空行 → 原样返回', () => {
    const noFm = 'just prose\n---\nnot frontmatter\n---\n'
    expect(patchFrontmatterPath(noFm, at('workflow'), 'x')).toBe(noFm)
    expect(patchFrontmatterPath(noFm, at('workflow'), null)).toBe(noFm)
    const unclosed = `---\nname: x\n${KEY}:\n  workflow: old\nBODY WITHOUT CLOSE.`
    expect(patchFrontmatterPath(unclosed, at('workflow'), 'new')).toBe(unclosed)
    expect(patchFrontmatterPath(DOC, [], 'x')).toBe(DOC)
    const leading = `\n---\n${KEY}:\n  workflow: old\n---\nB`
    expect(patchFrontmatterPath(leading, at('workflow'), 'new')).toBe(leading)
  })

  it('P15 正文里的同名块与正文 ---（hr）不受影响（i < close 的边界）', () => {
    const text = [
      '---',
      'name: x',
      `${KEY}:`,
      '  workflow: fm-value',
      '---',
      '',
      `${KEY}:`,
      '  workflow: body-value',
      '',
      '---',
      '',
      'after the hr.'
    ].join('\n')
    expect(patchFrontmatterPath(text, at('workflow'), 'patched')).toBe(
      text.replace('  workflow: fm-value', '  workflow: patched')
    )
    // 删除同理只动 frontmatter 里那两行（叶子 + 级联的顶层键）
    expect(patchFrontmatterPath(text, at('workflow'), null)).toBe(
      text.replace(`${KEY}:\n  workflow: fm-value\n`, '')
    )
  })

  it('P16 键按字面匹配：含正则元字符的键不误配（`a.b` 不命中 `axb`）；近似前缀键 shuvix-bot-pipeline-extra 不误伤', () => {
    // 对照 patchFrontmatterScalar 文件头记录的隐患（key 原样拼进正则）—— 这里 escapeRegExp 过了
    const text = ['---', 'axb: 1', `${KEY}-extra:`, '  workflow: keep-me', '---', 'B'].join('\n')
    const dotted = patchFrontmatterPath(text, ['a.b'], 'set')
    expect(dotted).toContain('axb: 1')
    expect(dotted).toContain('\na.b: set\n')
    expect(patchFrontmatterPath(text, at('workflow'), 'new')).toBe(
      [
        '---',
        'axb: 1',
        `${KEY}-extra:`,
        '  workflow: keep-me',
        `${KEY}:`,
        '  workflow: new',
        '---',
        'B'
      ].join('\n')
    )
  })

  it('P17 ⚠️ 钉现状：目标行整行重铸 —— 行尾注释与 `key : v` 的空格风格随之消失', () => {
    const text = ['---', `${KEY}:`, '  workflow : old   # keep?', '---', 'B'].join('\n')
    expect(patchFrontmatterPath(text, at('workflow'), 'new')).toBe(
      ['---', `${KEY}:`, '  workflow: new', '---', 'B'].join('\n')
    )
  })

  it('P18 父键行存在但为空（`agents:` 下没有子行）→ 子行以父缩进 + 2 追加', () => {
    const nullAgents = ['---', `${KEY}:`, '  workflow: bot-chat', '  agents:', '---', 'B'].join(
      '\n'
    )
    expect(patchFrontmatterPath(nullAgents, at('agents', 'intent'), 'i')).toBe(
      ['---', `${KEY}:`, '  workflow: bot-chat', '  agents:', '    intent: i', '---', 'B'].join(
        '\n'
      )
    )
  })

  it('P19 块内空行算块内、块尾空行不算：追加落在最后一条条目之后，不是空行之后', () => {
    const spaced = [
      '---',
      `${KEY}:`,
      '  workflow: bot-chat',
      '',
      '  agents:',
      '    intent: bot-intent',
      '',
      '---',
      'B'
    ].join('\n')
    // 同层追加：在 intent 之后、空行之前
    expect(patchFrontmatterPath(spaced, at('agents', 'task'), 'default')).toBe(
      spaced.replace('    intent: bot-intent\n', '    intent: bot-intent\n    task: default\n')
    )
    // 新起一层：同样在块的最后一条之后、尾部空行之前
    expect(patchFrontmatterPath(spaced, at('input', 'tone'), 'terse')).toBe(
      spaced.replace(
        '    intent: bot-intent\n',
        '    intent: bot-intent\n  input:\n    tone: terse\n'
      )
    )
  })

  it('P20 键重复时只动第一处（与 A9 同一现状：YAML 语义以后者为准，本函数认前者）', () => {
    const text = ['---', `${KEY}:`, '  workflow: first', '  workflow: second', '---', 'B'].join(
      '\n'
    )
    expect(patchFrontmatterPath(text, at('workflow'), 'patched')).toBe(
      ['---', `${KEY}:`, '  workflow: patched', '  workflow: second', '---', 'B'].join('\n')
    )
  })
})
