/**
 * bot 定义文件（`shuvix: bot`）的解析 / 序列化契约。
 *
 * **一个 bot 是身份三行 + 一篇正文**：`name` / `shuvix-displayName` / `description`，加上人设与
 * 记忆那篇散文。它不声明工具、不声明模型、不绑管线 —— 怎么干活由基座档案 `bot` 统一规定，跑在
 * 哪条会话上由会话说了算。agent 键写在 bot 上只是被忽略，不判非法（PX 组）。
 *
 * 与同族 md（agent / policy / workflow）同口径：文件类型标记**写入恒有、读取可选**，未知键忽略，
 * 整份拒绝时 `null` + **恰一条**人读诊断。`description` 可缺 —— 它只剩「列表里的一句话」这一个用途。
 *
 * 最要紧的一条收紧在 PR-4：标记类型不符整份拒绝 —— 正文会被围栏后贴进根 Agent 的系统提示词，
 * 一份误投进 bots 目录的 agent md 会当场变成某人的人设。最要紧的一条放宽在 BX 组：v1 文件
 * （带已拆除的管线块）照常解析，只发一条软提示。
 *
 * 分组：PP 合法形状与缺省 · PR 整份拒绝清单 · PX 宽松侧 · BX v1 残留 · PS 序列化 · PD 属性卡对齐
 *
 * 断言到消息文本一律用子串/正则而非全等：拒绝理由是档案页横幅与 IPC error 的唯一文案
 * 来源，要钉的是「点名了哪个键、给没给期望写法」，不是标点。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHUVIX_MD_DESCRIPTORS } from '@shuvix/chat-protocol/shuvixMdDescriptors'
import { SHUVIX_MARKER_KEY } from '@shuvix/chat-protocol/shuvixMdContract'
import {
  BOT_FILE_MARKER,
  BOT_FILE_MARKER_KEY,
  BOT_FILE_MARKER_TYPE,
  parseBotDefinitionFile,
  serializeBotDefinitionFile,
  type ParsedBotFile
} from '../botFile'

const md = (...lines: string[]): string => lines.join('\n')

/** 最小合法 bot：`name` + 正文；`fm` 追加在 frontmatter 里 */
const botMd = (...fm: string[]): string => md('---', 'name: scout', ...fm, '---', 'body')

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

/** ParsedBotFile 的全部字段名（接口加了字段而序列化忘了跟进，PS-2 先响） */
const PARSED_BOT_KEYS = ['body', 'description', 'displayName', 'name']

/** frontmatter 的顶层键序（序列化产物的可读性契约） */
const frontmatterKeys = (text: string): string[] =>
  (/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '')
    .split('\n')
    .map((l) => /^([\w-]+):/.exec(l)?.[1])
    .filter((k): k is string => !!k)

// ────────────────────────────── PP：合法形状与缺省 ──────────────────────────────

describe('PP —— 解析：合法形状与缺省', () => {
  it('PP-1 最小合法文件（frontmatter 的 name + 正文）四个字段齐出 —— 格式的下限', () => {
    // 这就是手写一份 bot 的最小代价：一行 name、一篇正文。多一个必填键，
    // 「用户自己在编辑器里写一个 bot」这条路就贵一分
    expect(parseBotDefinitionFile(botMd(), 'fn')).toEqual({
      name: 'scout',
      displayName: 'scout',
      description: '',
      body: 'body'
    })
  })

  it('PP-2 完整文件逐字段落位（name / shuvix-displayName / description / 正文）', () => {
    const raw = md(
      '---',
      `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`,
      'name: scout',
      'description: 侦察与调研',
      'shuvix-displayName: 侦察兵',
      '---',
      '## 我是谁',
      '',
      '你言简意赅。',
      '',
      '## 我记得什么',
      '',
      '- 这个仓库用 pnpm'
    )
    // defaultName 给一个不同的值：frontmatter 的 name 必须压过它（文件改名之后两者永久分叉）
    expect(parseBotDefinitionFile(raw, 'other-name')).toEqual({
      name: 'scout',
      displayName: '侦察兵',
      description: '侦察与调研',
      // 正文是**整篇** —— 人设与记忆是同一篇文档的不同段落，没有分界线、没有条目格式
      body: md('## 我是谁', '', '你言简意赅。', '', '## 我记得什么', '', '- 这个仓库用 pnpm')
    })
  })

  it('PP-3 缺省表：displayName → name、description → 空串、name → 文件基名', () => {
    // 三条缺省各有消费方：displayName 是侧栏与围栏里的称呼，description 是列表里那句话，
    // name 是会话 `settings.bot` 存的那个标识 —— 缺了 name 就只能拿文件名顶上
    const parsed = parseBotDefinitionFile(md('---', '---', 'body'), 'scout')!
    expect(parsed.name).toBe('scout')
    expect(parsed.displayName).toBe('scout')
    expect(parsed.description).toBe('')
  })

  it('PP-4 三个可选键写成 YAML null 等同省略 —— 编辑器里最常见的中间态不得判非法', () => {
    // 「删掉值、还没来得及写新的」是保存那一刻最可能的形态。判非法会让这个 bot 当场
    // 从列表里消失，而用户看到的只是自己在编辑器里敲了个退格
    const { result, messages } = parseWithWarn(
      md('---', 'name:', 'shuvix-displayName:', 'description:', '---', 'body'),
      'fn'
    )
    expect(result).toEqual({ name: 'fn', displayName: 'fn', description: '', body: 'body' })
    expect(messages).toEqual([])
  })

  it('PP-5 标量两端 trim；正文只 trim 首尾，内部空行与行尾空格原样', () => {
    // 剪的是**整段正文的两端**，不是逐行右端：markdown 里行尾两个空格是硬换行，
    // 逐行剪等于替用户改文档 —— 正文是用户写的散文，不是配置值
    const parsed = parseBotDefinitionFile(
      md(
        '---',
        "name: '  scout  '",
        "shuvix-displayName: '  侦察兵  '",
        "description: '  一句话  '",
        '---',
        '',
        '  第一行。  ',
        '',
        '第三行',
        '',
        ''
      ),
      'fn'
    )!
    expect(parsed.name).toBe('scout')
    expect(parsed.displayName).toBe('侦察兵')
    expect(parsed.description).toBe('一句话')
    // 首端的两个空格随整段 trim 一起没了；`第一行。` 后面那两个空格是内容，原样活着
    expect(parsed.body).toBe(md('第一行。  ', '', '第三行'))
  })

  it('PP-6 空正文合法 —— 新建出来的 bot 什么都还没学到', () => {
    // 拒绝它会让「先建个空壳、再慢慢喂」这条最自然的路走不通，也会让 botService.create
    // 在模板正文被清空时当场失败
    for (const raw of [
      botMd() + '',
      md('---', 'name: scout', '---'),
      md('---', 'name: scout', '---', '   \n\t')
    ]) {
      const parsed = parseBotDefinitionFile(raw, 'fn')
      expect(parsed, raw).not.toBeNull()
    }
    expect(parseBotDefinitionFile(md('---', 'name: scout', '---', '  \n\t\n'), 'fn')!.body).toBe('')
  })

  it('PP-7 正文里的 {{shuvix:*}} 原样保留 —— 本层不展开（钉住今天的行为）', () => {
    // 内置档案的占位符在 createAgent 时替换，而 bot 正文走的是 systemContext 那条路，
    // 不经过那张变量表。写了占位符的用户会看到它原样出现在提示词里 —— 这是现状，不是设计
    const body = 'Dir: {{shuvix:workingDirectory}} / {{unknown}}'
    expect(parseBotDefinitionFile(md('---', 'name: scout', '---', body), 'fn')!.body).toBe(body)
  })

  it('PP-8 容忍 BOM 与 CRLF；正文里的 --- 行不重开 frontmatter', () => {
    // BOM 来自 Windows 记事本，CRLF 来自 git 的 autocrlf —— 两样都是用户手写文件的常态
    const bom = parseBotDefinitionFile(
      '﻿---\r\nname: scout\r\ndescription: d\r\n---\r\nbody line\r\n',
      'fn'
    )
    expect(bom).not.toBeNull()
    expect(bom!.name).toBe('scout')
    expect(bom!.description).toBe('d')

    // 正文中段的 --- 是 markdown 分隔线，不是第二个 frontmatter（FRONTMATTER_RE 不带 m 标志）
    const withRule = parseBotDefinitionFile(
      md('---', 'name: scout', '---', 'intro', '', '---', '', 'name: hijacked', 'outro'),
      'fn'
    )!
    expect(withRule.name).toBe('scout')
    expect(withRule.body).toBe(md('intro', '', '---', '', 'name: hijacked', 'outro'))
  })

  it('PP-9 空 frontmatter（--- 紧跟 ---）解析成全缺省而非拒绝', () => {
    // 与 chat-protocol 侧的判别正则刻意不合并：那侧拒绝空块，解析侧接受（全字段走缺省）。
    // 后果是「只剩一对定界线」的文件仍是一个活着的 bot，名字取文件基名
    const { result, messages } = parseWithWarn(md('---', '---', 'body'), 'fn')
    expect(result).toEqual({ name: 'fn', displayName: 'fn', description: '', body: 'body' })
    expect(messages).toEqual([])
  })
})

// ────────────────────────────── PR：整份拒绝清单 ──────────────────────────────

describe('PR —— 整份拒绝清单（逐条 + warn 人读原因）', () => {
  it('PR-1 无 frontmatter → null + 恰一条 warn，主语是文件基名', () => {
    // frontmatter 都还没读到，`name` 无从谈起 —— 此时唯一能指认这份文件的就是文件名
    const reason = rejectReason('just a plain markdown body', 'scout.md')
    expect(reason).toMatch(/^bot 'scout\.md': /)
    expect(reason).toContain('no YAML frontmatter block')
  })

  it('PR-2 YAML 语法错 → null，yaml 自己的多行报错原样透出', () => {
    // 那段文字就是档案页横幅上显示的全部内容：带 ^ 指位行的代码框比「YAML 无效」有用得多
    const reason = rejectReason(md('---', '[unclosed', '---', 'body'))
    expect(reason).toContain('invalid YAML')
    expect(reason.split('\n').length).toBeGreaterThan(1)
  })

  it('PR-3 frontmatter 不是映射（列表 / 裸标量）→ null', () => {
    for (const fm of [md('- a', '- b'), 'just a scalar']) {
      expect(rejectReason(md('---', fm, '---', 'body')), fm).toContain(
        'frontmatter must be a mapping'
      )
    }
  })

  it('PR-4 带 shuvix: agent v1 的文件整份拒绝，理由同时点出「读到什么」与「期望什么」', () => {
    // **本文件后果最重的一条**。bots 是平铺扫描的目录，误投一份 agent md 进来，
    // 放行就意味着那份工程提示词被当作某人的人设贴进根 Agent 的系统提示词 ——
    // 比报错糟得多。
    const reason = rejectReason(
      md('---', `${BOT_FILE_MARKER_KEY}: agent v1`, 'name: coder', '---', 'body')
    )
    // 读到什么（agent）+ 期望什么（bot v2）：少任何一半，用户都不知道该改哪一行
    expect(reason).toContain(`'${BOT_FILE_MARKER_KEY}: agent'`)
    expect(reason).toContain(`'${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}'`)
    // who 取 frontmatter 的 name（标记检查排在 name 解析之后）
    expect(reason).toMatch(/^bot 'coder': /)

    // 同族的另外几种误投一样被拒
    for (const marker of ['policy v1', 'workflow v1', 'persona v1', 'okf v0.2']) {
      expect(
        rejectReason(md('---', `${BOT_FILE_MARKER_KEY}: ${marker}`, '---', 'body')),
        marker
      ).toContain('is not a bot file')
    }
  })

  it('PR-5 shuvix: bot 的任意版本都被接受 —— 判别只看 type 段（v1 存量文件因此不会消失）', () => {
    // 版本号升一位不该让存量文件集体从列表里消失。判别与版本无关是全族 md 的共同约定
    for (const version of ['bot v1', 'bot v2', 'bot v3', 'bot']) {
      expect(
        parseBotDefinitionFile(
          md('---', `${BOT_FILE_MARKER_KEY}: ${version}`, 'name: scout', '---', 'body'),
          'fn'
        ),
        version
      ).not.toBeNull()
    }
    expect(BOT_FILE_MARKER_TYPE).toBe('bot')
    expect(BOT_FILE_MARKER).toBe(`${BOT_FILE_MARKER_TYPE} v2`)
  })

  it('PR-6 缺标记行被接受 —— 手写文件合法（标记写入恒有、读取可选）', () => {
    const { result, messages } = parseWithWarn(botMd())
    expect(result).not.toBeNull()
    expect(messages).toEqual([])
  })

  it('PR-7 description 非字符串 → 整份拒绝；shuvix-displayName 同', () => {
    // 非字符串不是「写空了」，是把一个映射/列表塞进了一个标量位 —— 静默丢弃会让用户
    // 的编辑看起来「保存成功但没生效」
    for (const [key, value] of [
      ['description', '42'],
      ['description', '[a, b]'],
      ['description', '{ a: 1 }'],
      ['shuvix-displayName', '[x]'],
      ['shuvix-displayName', 'true']
    ]) {
      expect(rejectReason(botMd(`${key}: ${value}`)), `${key}: ${value}`).toContain(
        `'${key}' must be a string`
      )
    }
  })

  it('PR-8 每条拒绝路径恰一条诊断；warn 可省略（不传不抛）', () => {
    // 消费方（botService.parseForWrite 把 messages join 成 error）读到的永远就是那一句原因
    const rejected = [
      'plain body, no frontmatter',
      '# Title\n\n---\nname: mid\n---\nbody',
      md('---', '[unclosed', '---', 'body'),
      md('---', '- a', '---', 'body'),
      md('---', 'scalar', '---', 'body'),
      md('---', `${BOT_FILE_MARKER_KEY}: agent v1`, '---', 'body'),
      botMd('description: 42'),
      botMd('shuvix-displayName: [x]')
    ]
    for (const raw of rejected) {
      const { result, messages } = parseWithWarn(raw, 'guard.md')
      expect(result, raw).toBeNull()
      expect(messages, raw).toHaveLength(1)
      // [\s\S] 而非 . —— YAML 语法错的原因本身是多行代码框
      expect(messages[0], raw).toMatch(/^bot '.+': [\s\S]+; the whole file is rejected$/)
    }

    // warn 是可选参数：省略时既不抛也不改变返回值
    for (const raw of [...rejected, botMd()]) {
      expect(() => parseBotDefinitionFile(raw, 'fn'), raw).not.toThrow()
      expect(parseBotDefinitionFile(raw, 'fn'), raw).toEqual(parseWithWarn(raw).result)
    }
  })
})

// ────────────────────────────── PX：宽松侧 ──────────────────────────────

describe('PX —— 宽松侧（与 agent md 同口径）', () => {
  it('PX-1 bot 上写 agent 键（tools / model / instruction-files）被忽略而非拒绝，零 warn', () => {
    // 一个 bot 只回答「你是谁」。工具面、模型、指令文件是**基座档案 `bot`** 与
    // **会话**的事 —— 写在这里既不生效也不该报错（同 agent md 的未知键口径）。
    // 判非法会把「从 agent md 抄了一半」这种常见起手式变成一次硬失败
    const { result, messages } = parseWithWarn(
      botMd(
        'shuvix-tools: read, bash',
        'shuvix-model: gpt-5',
        'shuvix-instruction-files: AGENTS.md',
        'shuvix-project-awareness: true',
        'shuvix-builtin: true',
        'tools: Read, Grep',
        'whenToUse: old style'
      )
    )
    expect(result).not.toBeNull()
    expect(messages).toEqual([])
    // 未知键一个都没长进产物里
    expect(Object.keys(result!).sort()).toEqual(PARSED_BOT_KEYS)
  })

  it('PX-2 缺 description 合法 —— v2 比 v1 宽松的一处', () => {
    // v1 里 description 是意图门判断相关性的功能要件（缺了整份拒绝）；
    // 门已拆除，它只剩「列表里的一句话」，缺了不影响任何机制
    const { result, messages } = parseWithWarn(botMd())
    expect(result!.description).toBe('')
    expect(messages).toEqual([])
    // 空串 / 纯空白同样合法（不是「必须非空」）
    expect(parseBotDefinitionFile(botMd("description: '   '"), 'fn')!.description).toBe('')
  })
})

// ────────────────────────────── BX：v1 残留 ──────────────────────────────

describe('BX —— v1 文件（带已拆除的管线块）', () => {
  const V1 = md(
    '---',
    'shuvix: bot v1',
    'name: scout',
    'description: 侦察与调研',
    'shuvix-bot-pipeline:',
    '  workflow: bot-chat',
    '  agents:',
    '    intent: bot-intent',
    '    task: work',
    '---',
    '## 我是谁',
    '',
    '你言简意赅。'
  )

  it('BX-1 v1 文件照常解析：身份与正文一字不差，管线块不进产物', () => {
    // 正文在 v1 里本来就是人设与记忆 —— 语义没变，所以用户已有的 bot 拆完管线之后应当原样可用
    expect(parseBotDefinitionFile(V1, 'fn')).toEqual({
      name: 'scout',
      displayName: 'scout',
      description: '侦察与调研',
      body: md('## 我是谁', '', '你言简意赅。')
    })
  })

  it('BX-2 恰一条软提示，点名残留的键并请用户删掉 —— 它看起来像配置，其实什么也不控制', () => {
    const { result, messages } = parseWithWarn(V1)
    expect(result).not.toBeNull()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/^bot 'scout': /)
    expect(messages[0]).toContain("'shuvix-bot-pipeline' is no longer used")
    expect(messages[0]).toMatch(/delete it$/)
    // 软提示不是拒绝：不带整份拒绝的收尾语
    expect(messages[0]).not.toMatch(/the whole file is rejected/)
  })

  it('BX-3 没有管线块的 v1 文件零提示 —— 提示只为那块残留而发，不为版本号', () => {
    const { result, messages } = parseWithWarn(
      md('---', 'shuvix: bot v1', 'name: scout', '---', 'body')
    )
    expect(result).not.toBeNull()
    expect(messages).toEqual([])
  })
})

// ────────────────────────────── PS：序列化 ──────────────────────────────

describe('PS —— 序列化（与解析互逆）', () => {
  const FULL: ParsedBotFile = {
    name: 'scout',
    displayName: '侦察兵',
    description: '侦察与调研',
    body: md('## 我是谁', '', '你言简意赅。', '', '- prefers pnpm')
  }

  it('PS-1 序列化 → 解析往返一个完整对象；标记恒为第一行', () => {
    expect(parseBotDefinitionFile(serializeBotDefinitionFile(FULL), 'other-name')).toEqual(FULL)
    // 标记写在 frontmatter 首位：属性卡按它选描述符（读不到 = 根本不渲染卡片）
    expect(serializeBotDefinitionFile(FULL).split('\n')[1]).toBe(
      `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`
    )
    // 全字段覆盖守卫：接口加了字段却忘了序列化，这里先响
    expect(Object.keys(FULL).sort()).toEqual(PARSED_BOT_KEYS)
  })

  it('PS-2 最小对象逐字节稳定：缺省省略、键序固定、二次幂等', () => {
    // displayName === name 时不写键（读回即 name）—— 否则每份新建文件都带一行没有信息的重复
    const minimal = serializeBotDefinitionFile({
      name: 'scout',
      displayName: 'scout',
      description: 'd',
      body: 'body'
    })
    expect(minimal).toBe(
      md(
        '---',
        `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`,
        'name: scout',
        'description: d',
        '---',
        '',
        'body',
        ''
      )
    )

    // description 也缺省省略：只剩标记 + name 的最小骨架
    expect(serializeBotDefinitionFile({ name: 'scout', body: 'body' })).toBe(
      md('---', `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`, 'name: scout', '---', '', 'body', '')
    )

    // 键序固定（属性卡与 diff 的可读性）：标记 → name → description → displayName
    expect(frontmatterKeys(serializeBotDefinitionFile(FULL))).toEqual([
      BOT_FILE_MARKER_KEY,
      'name',
      'description',
      'shuvix-displayName'
    ])

    // 幂等：归一化只发生一次，往返再序列化逐字节相同
    const once = serializeBotDefinitionFile(FULL)
    expect(serializeBotDefinitionFile(parseBotDefinitionFile(once, 'x')!)).toBe(once)
    // 正文两端的空白在第一次序列化时被归一（故它不是不动点，二次才是）
    const messy = serializeBotDefinitionFile({ ...FULL, body: '\n\n  x  \n\n' })
    expect(messy).toContain('\n\nx\n')
    expect(serializeBotDefinitionFile(parseBotDefinitionFile(messy, 'x')!)).toBe(messy)
  })

  it('PS-3 调用点白名单：序列化器只服务「新建 bot」', () => {
    // 它从固定键白名单重建 frontmatter，会丢注释、键序与未知键 —— **已存在的文件永远
    // 不该经过它**：日常维护由 bot 自己用 `edit` 就地改，用户的编辑由笔记本自动保存原样落盘。
    // 这条守卫在有人图省事用 serialize 改写已有文件时先响
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

    const callers = sources
      .filter((s) =>
        s.text
          .split('\n')
          .some((l) => l.includes('serializeBotDefinitionFile(') && !l.includes('function '))
      )
      .map((s) => s.path.slice(repoRoot.length))
    expect(callers).toEqual(['apps/desktop/src/main/services/botService.ts'])

    const service = sources.find((s) => s.path.endsWith('services/botService.ts'))!.text
    // 唯一调用点在「新建 bot」的模板生成里
    expect(service).toMatch(/newBotTemplate\([\s\S]*?serializeBotDefinitionFile\(/)
    // 而本服务从不改写已有文件：唯一一处写盘是 create 落在新派生路径上的那份原文
    expect(service.match(/writeFileAtomic\(/g)).toHaveLength(1)
    expect(service).toContain('writeFileAtomic(filePath, text)')
  })
})

// ─────────────── PD：属性卡描述符（chat-protocol）与解析器的对齐 ───────────────

describe('PD —— 属性卡描述符与解析器的对齐', () => {
  it('PD-1 描述符键恰为解析器读的那些，且 shuvix 标记行不在其中', () => {
    // 卡片能改的字段必须恰好是解析器会读的字段：多一个 = 改了不生效，少一个 = 卡上看不见。
    // 标记行刻意不在卡上 —— 它是「这份文件是什么」的判据，改它等于换一种文件
    const descriptor = SHUVIX_MD_DESCRIPTORS.find((d) => d.type === BOT_FILE_MARKER_TYPE)!
    const cardKeys = descriptor.fields.map((f) => f.key)
    // 刻意写成字面量而不是引常量：两边都引常量就什么都钉不住
    expect([...cardKeys].sort()).toEqual(['description', 'name', 'shuvix-displayName'])
    expect(cardKeys).not.toContain(SHUVIX_MARKER_KEY)
    expect(BOT_FILE_MARKER_KEY).toBe(SHUVIX_MARKER_KEY)

    // 正文（人设与记忆）不是 frontmatter 字段，所以卡上没有它 —— 那是文档本身
    expect(cardKeys).not.toContain('body')
    // 没有管线/工具/模型字段：v2 相对 v1 的全部差别就在这里
    for (const gone of ['shuvix-bot-pipeline', 'shuvix-tools', 'shuvix-model']) {
      expect(cardKeys, gone).not.toContain(gone)
    }
  })
})
