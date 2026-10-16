/**
 * 知识库条目的**提交检查**（review.ts）—— `knowledge` 工具 `submit` 宿主无关的那一半。
 *
 * 写手（内置 `knowledge-writer`）只判、不盖章：它经结果契约交回 `{passed, report}`，通过之后由**宿主**
 * 在 `verified` 里记一笔机器确认、把 `generated` 改回提交者。本文件钉四件事：
 *
 *   KR-1..KR-3   常量与结果契约：写手是宿主专用档案；契约 schema 合法，且写手不能借它夹带别的字段
 *   KR-4..KR-6   派给写手的任务文本：只给这一次的事实，规范住在写手的 md 里
 *   KR-7         交回结果的读法：形状不对一律读成「没有结论」，绝不能读成通过
 *   KR-10..KR-27 盖章（stampKnowledgeReview）：行级改写只动 frontmatter 的那两个顶层键；旧机器章让位、
 *                人工章原样保留；结果经真 YAML 回读、信任档按为当前内容背书的那几条判
 *
 * 记号：`S` = submittedBy（提交者），`R` = reviewer（写手），`T` = 这次盖章的时刻；T0 < T。
 */
import { describe, it, expect } from 'vitest'
import { invokeTool } from '../../tools/testing/invokeTool'
import { NextTool, resultContractTools, validateContractSchema } from '../../subagent/nextTool'
import { BASE_PROFILE_NAMES, HOST_ONLY_PROFILE_NAMES } from '../../subagent/builtinAgents'
import { upsertFrontmatterMappings } from '../../shuvixMdWrite'
import {
  KNOWLEDGE_REVIEW_CONTRACT,
  KNOWLEDGE_WRITER_PROFILE_NAME,
  buildKnowledgeReviewPrompt,
  readKnowledgeReviewResult,
  stampKnowledgeReview,
  type KnowledgeReviewRequest
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
  it('KR-1 写手档案名是 knowledge-writer：宿主专用（派发工具按名解析不到），不是会话基座', () => {
    expect(KNOWLEDGE_WRITER_PROFILE_NAME).toBe('knowledge-writer')
    expect(HOST_ONLY_PROFILE_NAMES.has(KNOWLEDGE_WRITER_PROFILE_NAME)).toBe(true)
    expect(BASE_PROFILE_NAMES.has(KNOWLEDGE_WRITER_PROFILE_NAME)).toBe(false)
  })

  it('KR-2 结果契约的 schema 合法：恰两个必填字段、不收别的键；来源标签点名 knowledge submit', () => {
    // runTask 遇到非法契约会直接拒绝 —— 那整条 submit 就废了
    expect(validateContractSchema(KNOWLEDGE_REVIEW_CONTRACT.schema)).toBeNull()
    const schema = KNOWLEDGE_REVIEW_CONTRACT.schema as {
      type: string
      required: string[]
      additionalProperties: boolean
      properties: Record<string, { type: string }>
    }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['passed', 'report'])
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties).sort()).toEqual(['passed', 'report'])
    expect(schema.properties.passed.type).toBe('boolean')
    expect(schema.properties.report.type).toBe('string')
    expect(KNOWLEDGE_REVIEW_CONTRACT.sourceLabel).toBe('knowledge submit')
  })

  it.each([
    ['passed 不是布尔', { passed: 'yes', report: 'x' }],
    ['缺 report', { passed: true }],
    ['夹带 verified', { passed: true, report: 'x', verified: 'shuvix-knowledge-writer/haiku' }]
  ])(
    'KR-3 经 next 工具交回：%s → isError、不捕获；随后一次合规的调用才被捕获',
    async (_label, bad) => {
      // 写手只能交回 pass / fail —— 不能借契约夹带别的字段（如自己声明 verified）
      const [tool] = resultContractTools(KNOWLEDGE_REVIEW_CONTRACT) as [NextTool]
      expect(tool).toBeInstanceOf(NextTool)

      const rejected = (await invokeTool(tool, bad as Record<string, unknown>)).result
      expect(rejected.isError).toBe(true)
      expect(rejected.details).toBeUndefined()

      // 前一次没被捕获：同一个实例上紧接着合规的那一次才是「记下了」，带着结果与收尾信号
      const ok = (await invokeTool(tool, { passed: true, report: 'ok' })).result
      expect(ok.isError).toBeFalsy()
      expect(ok.details).toEqual({ result: { passed: true, report: 'ok' } })
      expect(ok.control).toEqual({ terminate: true })
    }
  )
})

describe('KR-4..KR-6 派给写手的任务文本', () => {
  const REQ: KnowledgeReviewRequest = {
    base: 'notes',
    label: 'knowledge base "notes"',
    bundleDir: '/u/notes',
    path: '/u/notes/sub/x.md',
    rel: 'sub/x.md',
    submittedBy: S
  }

  it('KR-4 逐行：一句任务 + 空行 + 条目 / 库 / 提交者三行事实', () => {
    expect(buildKnowledgeReviewPrompt(REQ).split('\n')).toEqual([
      'Check this knowledge-base entry and complete its metadata.',
      '',
      '- Entry: /u/notes/sub/x.md',
      '- Base: "notes" (knowledge base "notes") — /u/notes',
      `- Submitted by: ${S}`
    ])
  })

  it('KR-5 带 sessionId → 末尾多一行本会话的 shuvix:// 出处；不带 → 没有这一行、全文不提 shuvix://', () => {
    const withSession = buildKnowledgeReviewPrompt({ ...REQ, sessionId: 's1' }).split('\n')
    expect(withSession).toHaveLength(6)
    expect(withSession[5]).toBe(
      '- Source for what was established in the submitting conversation: shuvix://session/s1'
    )
    expect(withSession.slice(0, 5)).toEqual(buildKnowledgeReviewPrompt(REQ).split('\n'))

    expect(buildKnowledgeReviewPrompt(REQ)).not.toContain('shuvix://')
    expect(buildKnowledgeReviewPrompt({ ...REQ, sessionId: '' })).not.toContain('shuvix://')
  })

  it('KR-5b 带 workingDirectory → 多一行工作目录（只用来把相对路径拼成绝对路径，明说不去打开），排在会话出处之前；不带 → 没有这一行', () => {
    const lines = buildKnowledgeReviewPrompt({
      ...REQ,
      sessionId: 's1',
      workingDirectory: '/Users/me/acme'
    }).split('\n')
    expect(lines).toHaveLength(7)
    expect(lines[5]).toBe(
      '- Working directory of the submitting session (only for turning a relative path the entry names into an absolute one in sources; do not open anything there): /Users/me/acme'
    )
    expect(lines[6]).toContain('shuvix://session/s1')
    expect(buildKnowledgeReviewPrompt({ ...REQ, sessionId: 's1' })).not.toContain(
      'Working directory'
    )
  })

  it('KR-6 只给事实不给规范：没有自述行、没有类型词汇、没有 status —— 规范住在写手的 md 里（用户可覆盖）', () => {
    const text = buildKnowledgeReviewPrompt({ ...REQ, sessionId: 's1' })
    expect(text).not.toContain('shuvix: okf')
    for (const word of ['Decision', 'Runbook', 'Memory', 'Guide']) expect(text).not.toContain(word)
    expect(text).not.toContain('status')
    expect(text).not.toContain('verified')
  })
})

describe('KR-7 readKnowledgeReviewResult', () => {
  const TABLE: [string, unknown, { passed: boolean; report: string } | null][] = [
    ['undefined', undefined, null],
    ['null', null, null],
    ['JSON 字符串', '{"passed":true}', null],
    ['数字', 42, null],
    ['数组', [], null],
    ['空对象', {}, null],
    ['passed 是字符串', { passed: 'true' }, null],
    ['passed 是 1', { passed: 1 }, null],
    ['只有 passed', { passed: true }, { passed: true, report: '' }],
    [
      'report 去首尾空白',
      { passed: false, report: '  fix x \n' },
      { passed: false, report: 'fix x' }
    ],
    ['report 不是字符串', { passed: true, report: 5 }, { passed: true, report: '' }],
    ['多余键不外泄', { passed: true, report: 'r', extra: 1 }, { passed: true, report: 'r' }]
  ]

  it.each(TABLE)('KR-7 %s → %j', (_label, input, expected) => {
    // 形状不对必须读成「没有结论」（宿主据此报 error），绝不能读成通过
    const out = readKnowledgeReviewResult(input)
    if (expected === null) {
      expect(out).toBeNull()
      return
    }
    expect(out).toStrictEqual(expected)
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

  it('KR-21 回读一致：generated 是提交者、verified 是人工章 + 写手；核实仍当前，且信任档是机器确认（即便留着人工章）', () => {
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

  // KR-25（已知残留，CLAUDE.md 明列为 Not enforced）：被检查的 agent 可以自己 `edit` 进一条 `human:` 章 ——
  // 盖章原样保留它（宿主分不清哪条人工章是 UI 写的），at 晚于 T 时视图读成「人工审阅」。要堵它得把审阅挪进
  // applyWrite / applyEdit 的锁里比对前后版本，留待知识库页面一起做
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
