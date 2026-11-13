/**
 * 知识库的**提交**（review.ts）—— `knowledge` 工具 `submit` 宿主无关的那一半（2026-11-08 改版）。
 *
 * 别的 agent 不再自己往库里写：它交上来的是内容，宿主同步派知识库管理员（内置 `knowledge-writer`），
 * 由它拿着库目录和文件工具决定新建、改写、合并、改名、删除还是不收，经结果契约交回
 * `{accepted, entries, report}`。**管理员只记账、不盖章**：它报上来、仍合规的条目由宿主在 `verified` 里记
 * 一笔机器确认、把 `generated` 改回提交者。本文件钉四件事：
 *
 *   KR-1..KR-3   常量与结果契约：管理员是宿主专用档案；契约 schema 合法，且它不能借契约夹带别的字段
 *   KR-4..KR-6   派给管理员的任务文本：只给这一次的事实（库、目录、提交者、点名的条目、工作目录、会话出处），
 *                最后是提交的内容；规范住在管理员的 md 里
 *   KR-7..KR-8   交回结果的读法：形状不对一律读成「没有结论」，绝不能读成收了；条目名归一、坏项丢掉
 *   KR-10..KR-27 盖章（stampKnowledgeReview，行为未变）：行级改写只动 frontmatter 的那两个顶层键；旧机器章
 *                让位、人工章原样保留；结果经真 YAML 回读、信任档按为当前内容背书的那几条判
 *
 *   KR-28..KR-30 整理（`organize`，2026-11-12）：任务文本只说「整个库过一遍、没有东西要记」加库与发起者；
 *                结果契约没有 `accepted`；读法按 `organize` 认 —— 动了条目就算成了
 *   KR-31..KR-32 挤了的文件夹：按条目路径数每个文件夹直接放着几条，超过一打的列出来；任务文本里多一行事实
 *
 * 记号：`S` = submittedBy（提交者），`R` = reviewer（管理员的 actor），`T` = 这次盖章的时刻；T0 < T。
 */
import { describe, it, expect } from 'vitest'
import { invokeTool } from '../../tools/testing/invokeTool'
import { NextTool, resultContractTools, validateContractSchema } from '../../subagent/nextTool'
import { BASE_PROFILE_NAMES, HOST_ONLY_PROFILE_NAMES } from '../../subagent/builtinAgents'
import { upsertFrontmatterMappings } from '../../shuvixMdWrite'
import {
  KNOWLEDGE_ADMIN_CONTRACT,
  KNOWLEDGE_CROWDED_FOLDER,
  KNOWLEDGE_ENTRY_CHANGES,
  KNOWLEDGE_ORGANIZE_CONTRACT,
  KNOWLEDGE_WRITER_PROFILE_NAME,
  buildKnowledgeAdminPrompt,
  crowdedFolders,
  readKnowledgeAdminResult,
  stampKnowledgeReview,
  type KnowledgeEntryChangeRecord,
  type KnowledgeSubmission
} from '../review'
import { parseOkfText } from '../okfCodec'
import {
  currentTrustTierOf,
  isVerificationCurrent,
  parseConceptText,
  readKnowledgeNote
} from '../conceptFile'
import { toKnowledgeEntry } from '../entryView'

const S = 'shuvix-work/gpt-5'
const R = 'shuvix-knowledge-writer/haiku'
const T = '2026-10-12T08:00:00.000Z'
const T0 = '2026-09-01T00:00:00.000Z'
const STAMP = { submittedBy: S, reviewer: R, at: T }
/** 两个章在文件里的样子（JSON 引号即合法的 YAML 双引号串） */
const GENERATED_LINE = `generated: { by: "${S}", at: "${T}" }`
const VERIFIED_LINE = `verified: { by: "${R}", at: "${T}" }`

/** frontmatter 行 + 正文 */
const doc = (frontmatter: string[], body = 'body'): string =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n')

/** 盖章，结果不该是 null（是 null 就判红，免得后面的断言拿 null 说话） */
const stamp = (text: string, s: typeof STAMP = STAMP): string => {
  const out = stampKnowledgeReview(text, s)
  if (out === null) throw new Error(`expected a stamped text, got null for:\n${text}`)
  return out
}

/** frontmatter 的行（不含两条定界线） */
const frontmatterLines = (text: string): string[] => {
  const lines = text.split('\n')
  const close = lines.indexOf('---', 1)
  return lines.slice(1, close)
}

/** 经真 YAML 回读的顶层字段 */
const fieldsOf = (text: string): Record<string, unknown> => {
  const parsed = parseOkfText(text)
  if (!parsed) throw new Error(`not parseable:\n${text}`)
  return parsed.fields
}

describe('KR-1..KR-3 常量与结果契约', () => {
  it('KR-1 管理员档案名沿用 knowledge-writer：宿主专用（派发工具按名解析不到），不是会话基座', () => {
    expect(KNOWLEDGE_WRITER_PROFILE_NAME).toBe('knowledge-writer')
    expect(HOST_ONLY_PROFILE_NAMES.has(KNOWLEDGE_WRITER_PROFILE_NAME)).toBe(true)
    expect(BASE_PROFILE_NAMES.has(KNOWLEDGE_WRITER_PROFILE_NAME)).toBe(false)
  })

  it('KR-2 结果契约的 schema 合法：恰三个必填字段、不收别的键；entries 的每一项恰为 {entry, change}，change 只有三种；来源标签点名 knowledge submit', () => {
    // runTask 遇到非法契约会直接拒绝 —— 那整条 submit 就废了
    expect(validateContractSchema(KNOWLEDGE_ADMIN_CONTRACT.schema)).toBeNull()
    const schema = KNOWLEDGE_ADMIN_CONTRACT.schema as {
      type: string
      required: string[]
      additionalProperties: boolean
      properties: Record<
        string,
        {
          type: string
          description?: string
          items?: {
            type: string
            required: string[]
            additionalProperties: boolean
            properties: Record<string, { type: string; enum?: string[] }>
          }
        }
      >
    }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['accepted', 'entries', 'report'])
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties).sort()).toEqual(['accepted', 'entries', 'report'])
    expect(schema.properties.accepted.type).toBe('boolean')
    expect(schema.properties.report.type).toBe('string')
    expect(schema.properties.entries.type).toBe('array')

    const item = schema.properties.entries.items!
    expect(item.type).toBe('object')
    expect(item.required).toEqual(['entry', 'change'])
    expect(item.additionalProperties).toBe(false)
    expect(Object.keys(item.properties).sort()).toEqual(['change', 'entry'])
    expect(item.properties.entry.type).toBe('string')
    expect(item.properties.change.enum).toEqual(['created', 'updated', 'deleted'])
    expect([...KNOWLEDGE_ENTRY_CHANGES]).toEqual(['created', 'updated', 'deleted'])

    // 给管理员的说明：条目按库内路径点名、改名怎么报、报告里不写目录（提交者看不到目录）
    expect(schema.properties.entries.description).toContain('path inside the base')
    expect(schema.properties.entries.description).toContain('A rename is the old name deleted')
    expect(schema.properties.report.description).toContain('never by the directory')
    expect(KNOWLEDGE_ADMIN_CONTRACT.sourceLabel).toBe('knowledge submit')
  })

  it.each([
    ['accepted 不是布尔', { accepted: 'yes', entries: [], report: 'x' }],
    ['缺 entries', { accepted: true, report: 'x' }],
    ['缺 report', { accepted: true, entries: [] }],
    ['entries 不是数组', { accepted: true, entries: { entry: '/a.md' }, report: 'x' }],
    [
      '夹带 verified',
      { accepted: true, entries: [], report: 'x', verified: 'shuvix-knowledge-writer/haiku' }
    ],
    [
      'change 不在三种之内',
      { accepted: true, entries: [{ entry: '/a.md', change: 'renamed' }], report: 'x' }
    ],
    ['条目缺 change', { accepted: true, entries: [{ entry: '/a.md' }], report: 'x' }],
    [
      '条目夹带别的键',
      {
        accepted: true,
        entries: [{ entry: '/a.md', change: 'created', verified: true }],
        report: 'x'
      }
    ]
  ])(
    'KR-3 经 next 工具交回：%s → isError、不捕获；随后一次合规的调用才被捕获',
    async (_label, bad) => {
      // 管理员只能交回收没收、动了哪几条 —— 不能借契约夹带别的字段（如自己声明 verified）
      const [tool] = resultContractTools(KNOWLEDGE_ADMIN_CONTRACT) as [NextTool]
      expect(tool).toBeInstanceOf(NextTool)

      const rejected = (await invokeTool(tool, bad as Record<string, unknown>)).result
      expect(rejected.isError).toBe(true)
      expect(rejected.details).toBeUndefined()

      // 前一次没被捕获：同一个实例上紧接着合规的那一次才是「记下了」，带着结果与收尾信号
      const good = {
        accepted: true,
        entries: [
          { entry: '/auth/old.md', change: 'deleted' },
          { entry: '/auth/new.md', change: 'created' }
        ],
        report: 'Renamed it.'
      }
      const ok = (await invokeTool(tool, good)).result
      expect(ok.isError).toBeFalsy()
      expect(ok.details).toEqual({ result: good })
      expect(ok.control).toEqual({ terminate: true })
    }
  )
})

describe('KR-4..KR-6 派给管理员的任务文本', () => {
  const REQ: KnowledgeSubmission = {
    base: 'notes',
    label: 'knowledge base "notes"',
    bundleDir: '/u/notes',
    content: 'Token refresh must happen before expiry (src/auth/refresh.ts).',
    submittedBy: S
  }
  const ENTRY_LINE = '- It corrects or extends: /sub/x.md'
  const WORKDIR_LINE =
    '- Working directory of the submitting session (only for turning a relative path the submission names into an absolute one in sources; do not open anything there): /Users/me/acme'
  const SESSION_LINE =
    '- Source for what was established in the submitting conversation: shuvix://session/s1'

  it('KR-4 逐行：一句任务 + 空行 + 库（带目录）/ 提交者两行事实 + 空行 + `Submission:` + 空行 + 内容', () => {
    expect(buildKnowledgeAdminPrompt(REQ).split('\n')).toEqual([
      'Record this submission in the knowledge base.',
      '',
      '- Base: "notes" (knowledge base "notes") — directory /u/notes',
      `- Submitted by: ${S}`,
      '',
      'Submission:',
      '',
      'Token refresh must happen before expiry (src/auth/refresh.ts).'
    ])
  })

  it('KR-5 可选的三行按序排在提交者之后：点名的条目（`/rel`）→ 工作目录（明说只用来拼 sources 的绝对路径、不去打开）→ 会话出处', () => {
    const lines = buildKnowledgeAdminPrompt({
      ...REQ,
      entry: 'sub/x.md',
      workingDirectory: '/Users/me/acme',
      sessionId: 's1'
    }).split('\n')
    expect(lines).toEqual([
      'Record this submission in the knowledge base.',
      '',
      '- Base: "notes" (knowledge base "notes") — directory /u/notes',
      `- Submitted by: ${S}`,
      ENTRY_LINE,
      WORKDIR_LINE,
      SESSION_LINE,
      '',
      'Submission:',
      '',
      REQ.content
    ])
  })

  const OPTIONAL: [
    string,
    { entry?: string; workingDirectory?: string; sessionId?: string },
    string[]
  ][] = [
    ['只有 entry', { entry: 'sub/x.md' }, [ENTRY_LINE]],
    ['只有 workingDirectory', { workingDirectory: '/Users/me/acme' }, [WORKDIR_LINE]],
    ['只有 sessionId', { sessionId: 's1' }, [SESSION_LINE]],
    ['空串一概当没有', { entry: '', workingDirectory: '', sessionId: '' }, []]
  ]

  it.each(OPTIONAL)('KR-5b %s：事实行恰为这几行，其余不出现', (_label, extra, expected) => {
    const lines = buildKnowledgeAdminPrompt({ ...REQ, ...extra }).split('\n')
    expect(lines.slice(4, lines.indexOf('Submission:') - 1)).toEqual(expected)
    const text = lines.join('\n')
    if (!expected.includes(SESSION_LINE)) expect(text).not.toContain('shuvix://')
    if (!expected.includes(WORKDIR_LINE)) expect(text).not.toContain('Working directory')
    if (!expected.includes(ENTRY_LINE)) expect(text).not.toContain('corrects or extends')
  })

  it('KR-5c 内容排在最后：首尾空白去掉，内部的空行、缩进、markdown 原样', () => {
    const content = '\n\n## Token refresh\n\n- refresh early\n    indented code\n\nend.  \n\n'
    const text = buildKnowledgeAdminPrompt({ ...REQ, content, sessionId: 's1' })
    expect(
      text.endsWith(
        '\n\nSubmission:\n\n## Token refresh\n\n- refresh early\n    indented code\n\nend.'
      )
    ).toBe(true)
    expect(text.indexOf('Submission:')).toBeGreaterThan(text.indexOf('shuvix://session/s1'))
  })

  it('KR-6 只给事实不给规范：没有自述行、没有类型词汇、没有 status / verified —— 规范住在管理员的 md 里（用户可覆盖）', () => {
    const text = buildKnowledgeAdminPrompt({
      ...REQ,
      content: 'x',
      entry: 'a.md',
      workingDirectory: '/w',
      sessionId: 's1'
    })
    expect(text).not.toContain('shuvix: okf')
    for (const word of ['Decision', 'Runbook', 'Memory', 'Guide']) expect(text).not.toContain(word)
    expect(text).not.toContain('status')
    expect(text).not.toContain('verified')
  })
})

describe('KR-7..KR-8 readKnowledgeAdminResult', () => {
  type Read = { accepted: boolean; entries: KnowledgeEntryChangeRecord[]; report: string }
  const TABLE: [string, unknown, Read | null][] = [
    ['undefined', undefined, null],
    ['null', null, null],
    ['JSON 字符串', '{"accepted":true}', null],
    ['数字', 42, null],
    ['数组', [], null],
    ['空对象', {}, null],
    ['accepted 是字符串', { accepted: 'true', entries: [], report: '' }, null],
    ['accepted 是 1', { accepted: 1 }, null],
    // 旧契约的形状（passed）不是这一份的结论
    ['旧的 passed', { passed: true, report: 'ok' }, null],
    ['只有 accepted', { accepted: true }, { accepted: true, entries: [], report: '' }],
    [
      'report 去首尾空白',
      { accepted: false, entries: [], report: '  dup of /a.md \n' },
      { accepted: false, entries: [], report: 'dup of /a.md' }
    ],
    [
      'report 不是字符串',
      { accepted: true, report: 5 },
      { accepted: true, entries: [], report: '' }
    ],
    [
      'entries 不是数组',
      { accepted: true, entries: { entry: '/a.md', change: 'created' }, report: 'r' },
      { accepted: true, entries: [], report: 'r' }
    ],
    [
      '多余键不外泄',
      { accepted: true, entries: [], report: 'r', extra: 1, verified: 'x' },
      { accepted: true, entries: [], report: 'r' }
    ]
  ]

  it.each(TABLE)('KR-7 %s → %j', (_label, input, expected) => {
    // 形状不对必须读成「没有结论」（宿主据此报 error），绝不能读成收了
    const out = readKnowledgeAdminResult(input)
    if (expected === null) {
      expect(out).toBeNull()
      return
    }
    expect(out).toStrictEqual(expected)
  })

  it('KR-8 条目名归一成库内相对路径：去首尾空白、反斜杠转正、去前导 /（几个都去）；其余原样（不折叠 .. 、不补 .md）', () => {
    const out = readKnowledgeAdminResult({
      accepted: true,
      entries: [
        { entry: '/auth/x.md', change: 'created' },
        { entry: '  /auth/y.md  ', change: 'updated' },
        { entry: '//z.md', change: 'deleted' },
        { entry: 'sub\\w.md', change: 'updated' },
        { entry: '\\sub\\v.md', change: 'updated' },
        { entry: 'plain', change: 'created' },
        { entry: '../out.md', change: 'created' }
      ],
      report: 'r'
    })
    expect(out!.entries).toStrictEqual([
      { entry: 'auth/x.md', change: 'created' },
      { entry: 'auth/y.md', change: 'updated' },
      { entry: 'z.md', change: 'deleted' },
      { entry: 'sub/w.md', change: 'updated' },
      { entry: 'sub/v.md', change: 'updated' },
      { entry: 'plain', change: 'created' },
      { entry: '../out.md', change: 'created' }
    ])
  })

  it('KR-8b 坏项逐个丢掉、好项保序保重：不是对象、entry 不是字符串 / 归一后为空、change 不认得（大小写也算）；项上多余的键不外泄', () => {
    const out = readKnowledgeAdminResult({
      accepted: true,
      entries: [
        null,
        'a.md',
        42,
        ['a.md', 'created'],
        { entry: 5, change: 'created' },
        { entry: '', change: 'created' },
        { entry: '   ', change: 'created' },
        { entry: '/', change: 'created' },
        { entry: '/a.md' },
        { entry: '/a.md', change: 'renamed' },
        { entry: '/a.md', change: 'CREATED' },
        { change: 'created' },
        { entry: '/keep.md', change: 'created', title: 'K', verified: true },
        { entry: '/keep.md', change: 'updated' },
        { entry: '/gone.md', change: 'deleted' }
      ],
      report: 'r'
    })
    expect(out).toStrictEqual({
      accepted: true,
      entries: [
        { entry: 'keep.md', change: 'created' },
        { entry: 'keep.md', change: 'updated' },
        { entry: 'gone.md', change: 'deleted' }
      ],
      report: 'r'
    })
  })

  it('KR-8c 不收（accepted: false）时报上来的条目照样读出来 —— 收不收由工具判，读法不替它丢', () => {
    expect(
      readKnowledgeAdminResult({
        accepted: false,
        entries: [{ entry: '/a.md', change: 'updated' }],
        report: 'no'
      })
    ).toStrictEqual({
      accepted: false,
      entries: [{ entry: 'a.md', change: 'updated' }],
      report: 'no'
    })
  })
})

describe('KR-28..KR-30 整理（organize）', () => {
  const REQ: KnowledgeSubmission = {
    base: 'project',
    label: 'project "Acme"',
    bundleDir: '/kb/p1',
    content: '',
    submittedBy: S,
    organize: true
  }

  it('KR-28 任务文本：一句任务（没有东西交上来、整个库过一遍）+ 库（带目录）/ 发起者；转述的要求排在最后；没有 Submission、工作目录、会话出处', () => {
    expect(buildKnowledgeAdminPrompt(REQ).split('\n')).toEqual([
      'Reorganize this knowledge base. Nothing is being submitted: go through everything it holds.',
      '',
      '- Base: "project" (project "Acme") — directory /kb/p1',
      `- Asked for by: ${S}`
    ])
    const asked = buildKnowledgeAdminPrompt({
      ...REQ,
      content: '\n merge the auth notes \n',
      sessionId: 's1',
      workingDirectory: '/Users/me/acme'
    })
    expect(asked.split('\n').slice(4)).toEqual([
      '',
      'What was asked for in particular:',
      '',
      'merge the auth notes'
    ])
    for (const gone of ['Submission:', 'Working directory', 'shuvix://session', 'Submitted by']) {
      expect(asked, gone).not.toContain(gone)
    }
  })

  it('KR-29 结果契约：schema 合法，必填恰为 entries / report（没有 accepted），不收别的键；来源标签点名 knowledge organize', () => {
    expect(validateContractSchema(KNOWLEDGE_ORGANIZE_CONTRACT.schema)).toBeNull()
    const schema = KNOWLEDGE_ORGANIZE_CONTRACT.schema as {
      required: string[]
      additionalProperties: boolean
      properties: Record<string, unknown>
    }
    expect(schema.required).toEqual(['entries', 'report'])
    expect(Object.keys(schema.properties).sort()).toEqual(['entries', 'report'])
    expect(schema.additionalProperties).toBe(false)
    expect(KNOWLEDGE_ORGANIZE_CONTRACT.sourceLabel).toBe('knowledge organize')
  })

  it('KR-30 读法：按 organize 认 —— 没有 accepted 也是结论，动了条目 = 成了、一条没动 = 没成；entries 不是数组仍读成没有结论；按 submit 认时照旧要 accepted', () => {
    const changed = { entries: [{ entry: '/a.md', change: 'deleted' }], report: ' merged ' }
    expect(readKnowledgeAdminResult(changed, 'organize')).toEqual({
      accepted: true,
      entries: [{ entry: 'a.md', change: 'deleted' }],
      report: 'merged'
    })
    expect(readKnowledgeAdminResult({ entries: [], report: 'in order' }, 'organize')).toEqual({
      accepted: false,
      entries: [],
      report: 'in order'
    })
    expect(readKnowledgeAdminResult({ report: 'r' }, 'organize')).toBeNull()
    expect(readKnowledgeAdminResult(undefined, 'organize')).toBeNull()
    expect(readKnowledgeAdminResult(changed)).toBeNull()
    expect(readKnowledgeAdminResult(changed, 'submit')).toBeNull()
  })
})

describe('KR-31..KR-32 挤了的文件夹', () => {
  const many = (folder: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => `${folder}${folder ? '/' : ''}e${i}.md`)

  it('KR-31 crowdedFolders：只数文件夹里直接放着的条目（子文件夹里的不算），恰好一打不算挤；多的在前、同数按名字；路径归一（前导 /、反斜杠）', () => {
    expect(KNOWLEDGE_CROWDED_FOLDER).toBe(12)
    expect(crowdedFolders([])).toEqual([])
    expect(crowdedFolders(many('', 12))).toEqual([])
    expect(crowdedFolders(many('', 13))).toEqual([{ folder: '', entries: 13 }])
    // 顶层 2 条 + pay 14 条 + pay/refund 13 条 + auth 14 条：顶层与子文件夹各数各的
    expect(
      crowdedFolders([
        'a.md',
        '/b.md',
        ...many('pay', 14),
        ...many('pay\\refund', 13),
        ...many('/auth', 14)
      ])
    ).toEqual([
      { folder: 'auth', entries: 14 },
      { folder: 'pay', entries: 14 },
      { folder: 'pay/refund', entries: 13 }
    ])
  })

  it('KR-32 任务文本：提交与整理都在库那一行之后多一行，点名挤了的文件夹（顶层写成 the top level）；没有就没有这一行；迁移不带', () => {
    const base = {
      base: 'project',
      label: 'project "Acme"',
      bundleDir: '/kb/p1',
      submittedBy: S
    }
    const crowded = [
      { folder: '', entries: 27 },
      { folder: 'pay', entries: 14 }
    ]
    const LINE = '- Folders with more than 12 entries: the top level (27), /pay (14)'
    const submit = buildKnowledgeAdminPrompt({ ...base, content: 'x', crowded }).split('\n')
    expect(submit.slice(2, 5)).toEqual([
      '- Base: "project" (project "Acme") — directory /kb/p1',
      LINE,
      `- Submitted by: ${S}`
    ])
    const organize = buildKnowledgeAdminPrompt({ ...base, content: '', organize: true, crowded })
    expect(organize.split('\n').slice(2, 5)).toEqual([
      '- Base: "project" (project "Acme") — directory /kb/p1',
      LINE,
      `- Asked for by: ${S}`
    ])
    for (const none of [undefined, []]) {
      expect(buildKnowledgeAdminPrompt({ ...base, content: 'x', crowded: none })).not.toContain(
        'Folders with more than'
      )
    }
    expect(
      buildKnowledgeAdminPrompt({
        ...base,
        content: '',
        crowded,
        migration: { from: 'project "big"', entries: [{ entry: 'a.md', text: 'x' }] }
      })
    ).not.toContain('Folders with more than')
  })
})

describe('KR-10..KR-27 stampKnowledgeReview', () => {
  it('KR-10 没有 generated / verified：在闭合 `---` 之前依次追加两行；单条 verified 写成映射而非列表', () => {
    const before = doc(['shuvix: okf v0.2', 'type: Memory', 'title: A', 'description: da'])
    const after = stamp(before)
    expect(after).toBe(
      doc([
        'shuvix: okf v0.2',
        'type: Memory',
        'title: A',
        'description: da',
        GENERATED_LINE,
        VERIFIED_LINE
      ])
    )
    expect(fieldsOf(after).verified).toEqual({ by: R, at: T })
  })

  it('KR-11 已有单行流式 generated 在中间：原位替换，注释行与未知键的位置、字节不变；verified 追加在末尾', () => {
    const before = doc([
      'type: Memory',
      '# a comment the user wrote',
      'generated: { by: "shuvix-knowledge-writer/haiku", at: "2026-10-12T07:00:00.000Z" }',
      'x-foo: kept',
      'title: A'
    ])
    expect(frontmatterLines(stamp(before))).toEqual([
      'type: Memory',
      '# a comment the user wrote',
      GENERATED_LINE,
      'x-foo: kept',
      'title: A',
      VERIFIED_LINE
    ])
  })

  it('KR-12 块式 generated：整块换成一行流式，续行全删；结果经真 YAML 能解析', () => {
    const before = doc([
      'type: Memory',
      'generated:',
      '  by: shuvix-knowledge-writer/haiku',
      '  at: "2026-10-12T07:00:00.000Z"',
      'title: A'
    ])
    const after = stamp(before)
    expect(frontmatterLines(after)).toEqual([
      'type: Memory',
      GENERATED_LINE,
      'title: A',
      VERIFIED_LINE
    ])
    expect(fieldsOf(after).generated).toEqual({ by: S, at: T })
  })

  it('KR-13 块式序列 verified（人工 + 旧机器章）→ 一行列表：人工在前、旧机器章去掉、新机器章殿后', () => {
    const before = doc([
      'type: Memory',
      'verified:',
      '  - by: human:alice',
      `    at: "${T0}"`,
      '  - by: shuvix-x/y',
      `    at: "${T0}"`,
      'title: A'
    ])
    const after = stamp(before)
    // 人工章按 JSON 原样写出（宿主不替人改写他的记录），机器章按流式映射
    expect(frontmatterLines(after)).toEqual([
      'type: Memory',
      `verified: [{"by":"human:alice","at":"${T0}"}, { by: "${R}", at: "${T}" }]`,
      'title: A',
      GENERATED_LINE
    ])
    expect(fieldsOf(after).verified).toEqual([
      { by: 'human:alice', at: T0 },
      { by: R, at: T }
    ])
  })

  it('KR-14 只有一条旧机器章：换成新的那一条（单条映射），不会越堆越多', () => {
    const before = doc([
      'type: Memory',
      `verified: { by: "shuvix-knowledge-writer/old", at: "${T0}" }`
    ])
    const after = stamp(before)
    expect(fieldsOf(after).verified).toEqual({ by: R, at: T })
    expect(frontmatterLines(after).filter((l) => l.startsWith('verified'))).toEqual([VERIFIED_LINE])
  })

  it('KR-15 多条人工章：全部保留、原顺序；机器章永远在最后', () => {
    const before = doc([
      'type: Memory',
      'verified:',
      '  - { by: "human:carol", at: "2026-08-01T00:00:00.000Z" }',
      `  - { by: "shuvix-knowledge-writer/old", at: "${T0}" }`,
      '  - { by: "human:alice", at: "2026-08-15T00:00:00.000Z" }'
    ])
    expect(fieldsOf(stamp(before)).verified).toEqual([
      { by: 'human:carol', at: '2026-08-01T00:00:00.000Z' },
      { by: 'human:alice', at: '2026-08-15T00:00:00.000Z' },
      { by: R, at: T }
    ])
  })

  it('KR-16 不是「开头即 frontmatter」→ null；前导空行与 BOM 仍算 frontmatter', () => {
    for (const text of [
      '# no frontmatter\n\nbody\n',
      'a line before\n---\ntype: Memory\n---\nbody\n',
      '---\ntype: Memory\nbody without a closing line\n'
    ]) {
      expect(stampKnowledgeReview(text, STAMP), text).toBeNull()
    }
    for (const text of ['\n\n---\ntype: Memory\n---\nbody\n', '﻿---\ntype: Memory\n---\nbody\n']) {
      const out = stampKnowledgeReview(text, STAMP)
      expect(out, JSON.stringify(text)).not.toBeNull()
      expect(out).toContain(`\n${GENERATED_LINE}\n${VERIFIED_LINE}\n---\nbody\n`)
    }
  })

  it('KR-17 CRLF 文件：替换与插入的行以 `\\r` 结尾，其余行一字不改', () => {
    const before = [
      '---',
      'type: Memory',
      'generated: { by: "x", at: "2026-10-12T07:00:00.000Z" }',
      'title: A',
      '---',
      '',
      'body',
      ''
    ].join('\r\n')
    const after = stamp(before)
    expect(after).toBe(
      [
        '---',
        'type: Memory',
        GENERATED_LINE,
        'title: A',
        VERIFIED_LINE,
        '---',
        '',
        'body',
        ''
      ].join('\r\n')
    )
  })

  it('KR-18 正文字节不动：正文里的 `---`、`verified:`、`generated:` 字样都不是 frontmatter', () => {
    const body = [
      'intro',
      '',
      '---',
      '',
      'verified: x',
      'generated: y',
      '  verified: indented'
    ].join('\n')
    const before = doc(['type: Memory', 'title: A'], body)
    const after = stamp(before)
    const tail = (text: string): string => text.slice(text.indexOf('\n---\n') + 1)
    expect(tail(after)).toBe(tail(before))
    expect(frontmatterLines(after)).toEqual([
      'type: Memory',
      'title: A',
      GENERATED_LINE,
      VERIFIED_LINE
    ])
  })

  it('KR-19 引号与特殊字符：by 原样回读（JSON 引号即合法的 YAML 双引号串）', () => {
    const reviewer = 'shuvix-knowledge-writer/claude "x": 1'
    const submittedBy = 'shuvix-读书/模型 v2'
    const after = stamp(doc(['type: Memory']), { submittedBy, reviewer, at: T })
    const fields = fieldsOf(after)
    expect(fields.generated).toEqual({ by: submittedBy, at: T })
    expect(fields.verified).toEqual({ by: reviewer, at: T })
  })

  it('KR-20 幂等：同一输入盖两次，第二次原样交回第一次的结果（有人工章时也一样）', () => {
    for (const before of [
      doc(['type: Memory', 'title: A']),
      doc(['type: Memory', `verified: [{ by: "human:alice", at: "${T0}" }]`])
    ]) {
      const once = stamp(before)
      expect(stampKnowledgeReview(once, STAMP)).toBe(once)
    }
  })

  it('KR-21 回读一致：generated 是提交者、verified 是人工章 + 管理员；核实仍当前，且信任档是机器确认（即便留着人工章）', () => {
    const before = doc([
      'shuvix: okf v0.2',
      'type: Memory',
      'title: A',
      'description: da',
      `verified: { by: "human:alice", at: "${T0}" }`
    ])
    const concept = parseConceptText(stamp(before), 'a.md')!
    expect(concept).not.toBeNull()
    expect(concept.generated).toEqual({ by: S, at: T })
    expect(concept.verified).toEqual([
      { by: 'human:alice', at: T0 },
      { by: R, at: T }
    ])
    expect(isVerificationCurrent(concept)).toBe(true)
    // 人看过的是旧内容：为当前内容背书的只有这一次机器确认
    expect(currentTrustTierOf(concept)).toBe('machine-confirmed')
    expect(toKnowledgeEntry(concept, { bundle: 'projects/acme', now: new Date(T) }).trustTier).toBe(
      'machine-confirmed'
    )
  })

  it('KR-22 generated 原本排在 verified 之后：两者都原位替换，键序不变', () => {
    const before = doc([
      'type: Memory',
      `verified: { by: "shuvix-knowledge-writer/old", at: "${T0}" }`,
      'title: A',
      `generated: { by: "g", at: "${T0}" }`
    ])
    expect(frontmatterLines(stamp(before))).toEqual([
      'type: Memory',
      VERIFIED_LINE,
      'title: A',
      GENERATED_LINE
    ])
  })

  it('KR-23 只认顶层键：嵌在别的键底下的同名键原样不动，顶层另行追加', () => {
    const before = doc([
      'type: Memory',
      'meta:',
      '  verified: yes',
      '  generated: by hand',
      'sources:',
      '  - resource: /a.ts',
      '    generated: nested'
    ])
    const after = stamp(before)
    expect(frontmatterLines(after)).toEqual([
      'type: Memory',
      'meta:',
      '  verified: yes',
      '  generated: by hand',
      'sources:',
      '  - resource: /a.ts',
      '    generated: nested',
      GENERATED_LINE,
      VERIFIED_LINE
    ])
    const fields = fieldsOf(after)
    expect(fields.meta).toEqual({ verified: 'yes', generated: 'by hand' })
    expect(fields.sources).toEqual([{ resource: '/a.ts', generated: 'nested' }])
    expect(fields.verified).toEqual({ by: R, at: T })
  })

  it('KR-24 人工章原样保留：缺 at、多出来的键都留着；认不出形状的项（不是映射 / 没有字符串 by）与旧机器章一起让位', () => {
    const missingAt = stamp(doc(['type: Memory', 'verified: [{ by: "human:alice" }]']))
    expect(fieldsOf(missingAt).verified).toEqual([{ by: 'human:alice' }, { by: R, at: T }])

    const extraKey = stamp(
      doc([
        'type: Memory',
        `verified: { by: "human:alice", at: "${T0}", note: "checked against prod" }`
      ])
    )
    expect(fieldsOf(extraKey).verified).toEqual([
      { by: 'human:alice', at: T0, note: 'checked against prod' },
      { by: R, at: T }
    ])

    const junk = stamp(
      doc([
        'type: Memory',
        `verified: ["just a string", { at: "${T0}" }, { by: 5, at: "${T0}" }, { by: "shuvix-x/y", at: "${T0}" }]`
      ])
    )
    expect(fieldsOf(junk).verified).toEqual({ by: R, at: T })
  })

  // KR-25（已知残留，CLAUDE.md 明列为 Not enforced）：管理员（或绕开约定、直接拿文件工具碰库目录的 agent ——
  // 2026-11-08 裁决：只是约定、不是卡点）可以自己 `edit` 进一条 `human:` 章 —— 盖章原样保留它（宿主分不清哪条
  // 人工章是 UI 写的），at 晚于 T 时视图读成「人工审阅」。要堵它得把审阅挪进 applyWrite / applyEdit 的锁里比对
  // 前后版本，留待知识库页面一起做
  it.todo('KR-25 agent 用 edit 伪造的 `human:` 章不被保留为人工审阅（已知缺口，暂不修）')

  it('KR-26 upsertFrontmatterMappings 直测：没有 frontmatter → null；值都已是目标值 → 原串；多个键按给定顺序处理', () => {
    expect(upsertFrontmatterMappings('# no frontmatter\n', [['a', '{ x: 1 }']])).toBeNull()

    const same = '---\ntype: Memory\na: { x: 1 }\nb: { y: 2 }\n---\nbody\n'
    expect(
      upsertFrontmatterMappings(same, [
        ['a', '{ x: 1 }'],
        ['b', '{ y: 2 }']
      ])
    ).toBe(same)

    expect(
      upsertFrontmatterMappings('---\ntype: Memory\n---\n', [
        ['b', '{ y: 2 }'],
        ['a', '{ x: 1 }']
      ])
    ).toBe('---\ntype: Memory\nb: { y: 2 }\na: { x: 1 }\n---\n')
  })

  it('KR-27 人工章的 at 晚于这次盖章（时钟漂移）：保留，且按时间判它仍为当前内容背书 → human-reviewed', () => {
    const later = '2026-10-13T00:00:00.000Z'
    const after = stamp(
      doc(['shuvix: okf v0.2', 'type: Memory', `verified: { by: "human:alice", at: "${later}" }`])
    )
    const note = readKnowledgeNote(after, 'a.md')
    expect(note.concept!.verified).toEqual([
      { by: 'human:alice', at: later },
      { by: R, at: T }
    ])
    expect(currentTrustTierOf(note.concept!)).toBe('human-reviewed')
  })
})
