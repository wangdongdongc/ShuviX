/**
 * v3 读取器的 golden 用例 —— checked-in 的会话文件 + 它们的期望输出。
 *
 * fixtures/ 里的每一对 `<name>.jsonl` / `<name>.expected.json` 都由 piCrossCheck.test.ts 的生成器（X-16）
 * 经 pi 0.80 的真 API 建出、期望输出由 **pi** 算出（X-15 守着它们一直忠于 pi）。本文件一个 pi 的符号都不引：
 * pi 删掉之后，这些文件就是「旧会话该怎么显示」的唯一记录。
 *
 *   GD-0  fixture 清单完整：显式名单里每一个都有成对的两个文件；目录里没有多余文件，也不是空的
 *   GD-1  每份 fixture：当前位置 / 分支 id / 上下文 id / 运行配置 / issues / 投影消息与期望一致
 *   GD-2  由合法 fixture 派生的宽容用例（期望来自 pi 验证过的文件，变换写在代码里）：
 *         (a) 末尾追加一行截断的半行 → 输出不变，多一条 issue（那一行的物理行号）
 *         (b) 换成 CRLF 并插入空行（含头之前）→ 输出不变，没有 issue
 *         (c) 头的 cwd 为空 / cwd 与 timestamp 都删掉 → 输出不变
 *         (d) 在已知位置插入 BN-1 的每一种坏行 → 输出不变，issues 按行序、行号精确
 *         (e) G03 末尾追加一条指向不存在条目的 leaf → 输出不变，多一条 issue（追加那一行的行号）
 *         (f) 删掉分支上第 k 条（0<k<末条）→ 上下文 = 分支[k+1..]，唯一的 issue 是 line 0、点名缺的那条
 *         BOM：开头带 UTF-8 BOM → 输出与原文件相同，没有 issue
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  branchOf,
  harnessV3TextToChatMessages,
  parseHarnessV3Session,
  readHarnessV3Transcript,
  type HarnessV3Issue,
  type HarnessV3RunConfig
} from '../index'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** 显式名单：少一个、多一个都要在 GD-0 里看出来 */
const FIXTURES = [
  'G01-linear-basic',
  'G02-sidecars',
  'G03-rollback-continue',
  'G03b-rollback-tail',
  'G04a-rollback-to-root-tail',
  'G04b-rollback-to-root-continue',
  'G05-compaction-single',
  'G06a-compaction-multiple-later-cut',
  'G06b-compaction-multiple-earlier-cut',
  'G07-compaction-rolled-back',
  'G08-compaction-firstkept-missing',
  'G09-meta-entries',
  'G10-errors-images',
  'G11-model-switch-midway',
  'G12-header-only'
] as const

type FixtureName = (typeof FIXTURES)[number]

interface Expected {
  sessionId: string
  leafId: string | null
  branchIds: string[]
  contextEntryIds: string[]
  runConfig: HarnessV3RunConfig
  issues: HarnessV3Issue[]
  messages: unknown[]
}

const textOf = (name: FixtureName): string =>
  readFileSync(join(FIXTURE_DIR, `${name}.jsonl`), 'utf8')

const expectedOf = (name: FixtureName): Expected =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.expected.json`), 'utf8')) as Expected

/** 读取器在一份文本上的全部输出面（与 expected.json 同形） */
function facesOf(text: string, sessionId: string): Omit<Expected, 'sessionId'> {
  const parsed = parseHarnessV3Session(text)
  const transcript = readHarnessV3Transcript(text)
  return {
    leafId: parsed.leafId,
    branchIds: branchOf(parsed).entries.map((e) => e.id),
    contextEntryIds: transcript.contextEntries.map((e) => e.id),
    runConfig: transcript.runConfig,
    issues: transcript.issues,
    messages: harnessV3TextToChatMessages(text, sessionId).messages
  }
}

/** 派生文本与某份 fixture 输出一致，除了 issues（由调用方另行断言） */
function expectSameOutputAs(text: string, name: FixtureName): HarnessV3Issue[] {
  const expected = expectedOf(name)
  const { issues, ...faces } = facesOf(text, expected.sessionId)
  const { sessionId: _sid, issues: _none, ...wanted } = expected
  // toEqual 而不是 toStrictEqual：JSON 落盘丢掉了 undefined 的键
  expect(faces).toEqual(wanted)
  return issues
}

/** 文本按物理行切开 / 拼回（保留末尾换行） */
const split = (text: string): string[] => text.split('\n')
const joinLines = (lines: string[]): string => lines.join('\n')

describe('GD-0 fixture 清单', () => {
  it('显式名单里每一个都成对；目录里没有多余文件，也不是空的', () => {
    const files = readdirSync(FIXTURE_DIR).sort()
    expect(files.length).toBeGreaterThan(0)
    const wanted = FIXTURES.flatMap((n) => [`${n}.expected.json`, `${n}.jsonl`]).sort()
    expect(files).toEqual(wanted)
  })
})

describe('GD-1 每份 fixture 的输出与期望一致', () => {
  it.each(FIXTURES)('%s', (name) => {
    const expected = expectedOf(name)
    expect(facesOf(textOf(name), expected.sessionId)).toEqual({
      leafId: expected.leafId,
      branchIds: expected.branchIds,
      contextEntryIds: expected.contextEntryIds,
      runConfig: expected.runConfig,
      issues: expected.issues,
      messages: expected.messages
    })
    // 消息带的是传进去的 sessionId，不是文件头里的 id
    const header = parseHarnessV3Session(textOf(name)).header
    expect(header.id).toBe(name)
    expect(expected.sessionId).not.toBe(header.id)
  })
})

describe('GD-2 由合法 fixture 派生的宽容用例', () => {
  it('(a) 末尾追加一行截断的半行 → 输出不变，多一条 JSON issue', () => {
    const text = textOf('G01-linear-basic')
    expect(text.endsWith('\n')).toBe(true)
    const truncated = text + '{"type":"message","id":"zz","parentId":"'
    const issues = expectSameOutputAs(truncated, 'G01-linear-basic')
    expect(issues).toHaveLength(1)
    expect(issues[0].line).toBe(split(truncated).length)
    expect(issues[0].reason).toMatch(/JSON/)
  })

  it('(b) CRLF + 插入空行（含头之前）→ 输出不变，没有 issue', () => {
    const lines = split(textOf('G03-rollback-continue').replace(/\n$/, ''))
    const withBlanks: string[] = ['', '   ']
    lines.forEach((line, i) => {
      withBlanks.push(line)
      if (i % 3 === 1) withBlanks.push('')
      if (i % 4 === 2) withBlanks.push(' \t ')
    })
    const crlf = withBlanks.join('\r\n') + '\r\n'
    expect(expectSameOutputAs(crlf, 'G03-rollback-continue')).toEqual([])
  })

  it.each([
    ['cwd 为空', (h: Record<string, unknown>) => ({ ...h, cwd: '' })],
    [
      'cwd 与 timestamp 都删掉',
      (h: Record<string, unknown>) => {
        const { cwd: _c, timestamp: _t, ...rest } = h
        return rest
      }
    ]
  ])('(c) 头的 %s → 输出不变', (_label, patch) => {
    const lines = split(textOf('G01-linear-basic'))
    lines[0] = JSON.stringify(patch(JSON.parse(lines[0]) as Record<string, unknown>))
    const text = joinLines(lines)
    expect(expectSameOutputAs(text, 'G01-linear-basic')).toEqual([])
    expect(readHarnessV3Transcript(text).header.cwd).toBe('')
  })

  it('(d) 在已知位置插入 BN-1 的每一种坏行 → 输出不变，issues 按行序、行号精确', () => {
    const TS = '2026-01-01T00:00:00.000Z'
    const bad: Array<[string, RegExp]> = [
      ['{"type":"message","id":', /JSON/],
      ['null', /entry/],
      ['42', /entry/],
      ['"x"', /entry/],
      ['[]', /type/],
      [JSON.stringify({ id: 'b1', parentId: null, timestamp: TS }), /type/],
      [JSON.stringify({ type: 5, id: 'b2', parentId: null, timestamp: TS }), /type/],
      [JSON.stringify({ type: 'message', parentId: null, timestamp: TS }), /id/],
      [JSON.stringify({ type: 'message', id: '', parentId: null, timestamp: TS }), /id/],
      [JSON.stringify({ type: 'message', id: 7, parentId: null, timestamp: TS }), /id/],
      [JSON.stringify({ type: 'message', id: 'b3', timestamp: TS }), /parentId/],
      [JSON.stringify({ type: 'message', id: 'b4', parentId: 9, timestamp: TS }), /parentId/],
      [JSON.stringify({ type: 'message', id: 'b5', parentId: null }), /timestamp/],
      [JSON.stringify({ type: 'message', id: 'b6', parentId: null, timestamp: '' }), /timestamp/],
      [JSON.stringify({ type: 'leaf', id: 'b7', parentId: null, timestamp: TS }), /targetId/],
      [
        JSON.stringify({ type: 'leaf', id: 'b8', parentId: null, timestamp: TS, targetId: 3 }),
        /targetId/
      ]
    ]
    // 坏行轮流插在各条合法条目之后（头之后才开始），记下它们落在的物理行号
    const original = split(textOf('G01-linear-basic').replace(/\n$/, ''))
    const out: string[] = [original[0]]
    const badLines: Array<[number, RegExp]> = []
    let next = 0
    for (let i = 1; i < original.length; i++) {
      out.push(original[i])
      // 每条合法条目之后塞两行坏的（坏行用完为止），最后剩下的全堆在文件末尾
      for (let k = 0; k < 2 && next < bad.length; k++) {
        out.push(bad[next][0])
        badLines.push([out.length, bad[next][1]])
        next++
      }
    }
    while (next < bad.length) {
      out.push(bad[next][0])
      badLines.push([out.length, bad[next][1]])
      next++
    }
    const text = joinLines(out) + '\n'

    const issues = expectSameOutputAs(text, 'G01-linear-basic')
    expect(issues.map((i) => i.line)).toEqual(badLines.map(([line]) => line))
    issues.forEach((issue, i) => expect(issue.reason).toMatch(badLines[i][1]))
  })

  it('(e) G03 末尾追加一条指向不存在条目的 leaf → 输出不变，多一条 issue（追加那一行）', () => {
    const text = textOf('G03-rollback-continue')
    const expected = expectedOf('G03-rollback-continue')
    const ghost = JSON.stringify({
      type: 'leaf',
      id: 'ghost-leaf',
      parentId: expected.leafId,
      timestamp: '2026-01-01T00:00:00.000Z',
      targetId: 'ghost'
    })
    const appended = text + ghost + '\n'
    const issues = expectSameOutputAs(appended, 'G03-rollback-continue')
    expect(issues).toHaveLength(1)
    expect(issues[0].line).toBe(split(text).length)
    expect(issues[0].reason).toContain('ghost')
  })

  it('(f) 删掉分支上第 k 条 → 上下文 = 分支[k+1..]，唯一的 issue 是 line 0、点名缺的那条', () => {
    const expected = expectedOf('G01-linear-basic')
    const lines = split(textOf('G01-linear-basic'))
    // G01 是一条直线：没有 leaf 条目、没有压缩，第 k 条分支条目就在物理第 k+2 行
    expect(lines.length - 2).toBe(expected.branchIds.length)
    const k = 3
    expect(JSON.parse(lines[k + 1]).id).toBe(expected.branchIds[k])
    const text = joinLines([...lines.slice(0, k + 1), ...lines.slice(k + 2)])

    const transcript = readHarnessV3Transcript(text)
    expect(transcript.contextEntries.map((e) => e.id)).toEqual(expected.branchIds.slice(k + 1))
    expect(transcript.issues).toHaveLength(1)
    expect(transcript.issues[0].line).toBe(0)
    expect(transcript.issues[0].reason).toContain(expected.branchIds[k])
  })

  it('BOM：开头带 UTF-8 BOM → 输出与原文件相同，没有 issue', () => {
    const text = '﻿' + textOf('G01-linear-basic')
    expect(expectSameOutputAs(text, 'G01-linear-basic')).toEqual([])
    expect(readHarnessV3Transcript(text).header.id).toBe('G01-linear-basic')
  })
})
