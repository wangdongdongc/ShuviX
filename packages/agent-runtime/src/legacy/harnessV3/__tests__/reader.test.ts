/**
 * v3 JSONL 会话树的只读读取器 —— 手写文本上的契约用例（不引 pi：pi 删掉之后这些用例照样跑）。
 *
 * 语义对齐 pi 0.80.10 的 `JsonlSessionStorage.open` + `Session.buildContextEntries()`（对照曾由
 * piCrossCheck.test.ts 守着，P1-01 随 pi 0.80 删除前一直通过）；这里钉的是规则本身，以及读取器比 pi **宽容**的那一半 —— 它是给人看旧记录的，
 * 能看多少看多少：会话头坏了才拒绝，条目行坏了跳过并记 issue（物理行号），父条目缺失时分支停在缺口，
 * leaf 指向一个在它之前没出现过的条目时这条 leaf 不生效。issue 的 `reason` 措辞不是契约，只按片段匹配。
 *
 *   B1 解析 / 会话头
 *     BP-1  只有头（带 parentSession 与对象 metadata）：头字段精确；其余全空
 *     BP-2  头不可读 → HarnessV3FormatError（两个入口都抛）：空文本 / 非 JSON / 非对象 / type / version / id
 *     BP-3  cwd 空 / 缺 / 非字符串 → ''；[白盒] timestamp 缺 → ''，非对象 metadata、非字符串 parentSession 丢弃
 *     BP-4  头之前的空行 / 空白行无妨
 *     BP-5  未知条目类型：照收，推进 leaf，进分支与上下文，不产出消息
 *     BP-6  条目上的多余字段原样进上下文
 *     BOM   开头的 UTF-8 BOM 去掉
 *   B2 当前位置（leaf）
 *     BL-1…BL-8  见各用例
 *   B3 分支  BB-1 只取祖先  BB-2 parentId "" 视同根  BB-3 重复 id 后一行胜出
 *   B4 压缩过滤  BC-1…BC-7
 *   B5 运行配置  BR-1…BR-5
 *   B6 投影  BE-2 每条消息的 sessionId 是传入的参数（BE-1 曾在 piCrossCheck.test.ts 对照活路径的投影；
 *            投影冻结进本目录后两者就是同一份）
 *   B7 宽容  BN-1…BN-11
 *   B8 BG-3 包根导出读取器的三个入口；branchOf 是纯函数（两次结果相同、不改 session.issues）
 */
import { describe, expect, it } from 'vitest'
import {
  HarnessV3FormatError,
  branchOf,
  contextEntriesOf,
  harnessV3TextToChatMessages,
  parseHarnessV3Session,
  readHarnessV3Transcript,
  runConfigOf,
  type HarnessV3Entry
} from '../index'

// ─── 手写文本的积木 ───────────────────────────────────────────────────────

const HEADER_TS = '2026-01-01T00:00:00.000Z'
let tsSeq = 0
/** 每条条目一个递增的时间戳（投影的 createdAt 由它来） */
const ts = (): string => new Date(Date.parse(HEADER_TS) + ++tsSeq * 1000).toISOString()

type Obj = Record<string, unknown>

function header(over: Obj = {}): Obj {
  return { type: 'session', version: 3, id: 'hdr-id', timestamp: HEADER_TS, cwd: '/ws', ...over }
}

/** 头 + 条目行 → 文本（对象 JSON 化，字符串原样；末尾带换行） */
function jsonl(head: Obj | string, ...lines: Array<Obj | string>): string {
  return (
    [head, ...lines].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
  )
}

function msg(id: string, parentId: string | null, role: 'user' | 'assistant', text: string): Obj {
  const message =
    role === 'user'
      ? { role: 'user', content: [{ type: 'text', text }], timestamp: 1 }
      : {
          role: 'assistant',
          content: [{ type: 'text', text }],
          api: 'openai-completions',
          provider: 'msg-provider',
          model: 'msg-model',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: 'stop',
          timestamp: 2
        }
  return { type: 'message', id, parentId, timestamp: ts(), message }
}
const u = (id: string, parentId: string | null, text = `user ${id}`): Obj =>
  msg(id, parentId, 'user', text)
const a = (id: string, parentId: string | null, text = `assistant ${id}`): Obj =>
  msg(id, parentId, 'assistant', text)

const leaf = (id: string, parentId: string | null, targetId: string | null): Obj => ({
  type: 'leaf',
  id,
  parentId,
  timestamp: ts(),
  targetId
})
const comp = (id: string, parentId: string | null, firstKeptEntryId: string): Obj => ({
  type: 'compaction',
  id,
  parentId,
  timestamp: ts(),
  summary: `summary ${id}`,
  firstKeptEntryId,
  tokensBefore: 100
})
const mc = (id: string, parentId: string | null, provider: string, modelId: string): Obj => ({
  type: 'model_change',
  id,
  parentId,
  timestamp: ts(),
  provider,
  modelId
})
const tl = (id: string, parentId: string | null, thinkingLevel: string): Obj => ({
  type: 'thinking_level_change',
  id,
  parentId,
  timestamp: ts(),
  thinkingLevel
})
const custom = (id: string, parentId: string | null, customType: string, data?: unknown): Obj => ({
  type: 'custom',
  id,
  parentId,
  timestamp: ts(),
  customType,
  data
})
const label = (id: string, parentId: string | null, targetId: string): Obj => ({
  type: 'label',
  id,
  parentId,
  timestamp: ts(),
  targetId,
  label: 'marked'
})

const ids = (entries: readonly HarnessV3Entry[]): string[] => entries.map((e) => e.id)

/** 一份文本的常用输出面 */
function read(text: string): {
  leafId: string | null
  branch: string[]
  context: string[]
  issues: Array<{ line: number; reason: string }>
} {
  const parsed = parseHarnessV3Session(text)
  const transcript = readHarnessV3Transcript(text)
  return {
    leafId: parsed.leafId,
    branch: ids(branchOf(parsed).entries),
    context: ids(transcript.contextEntries),
    issues: transcript.issues
  }
}

const NULL_RUN_CONFIG = { provider: null, model: null, thinkingLevel: null }

// ─── B1 解析 / 会话头 ─────────────────────────────────────────────────────

describe('B1 解析与会话头', () => {
  it('BP-1 只有头（带 parentSession 与对象 metadata）：头字段精确，其余全空', () => {
    const text = jsonl(header({ parentSession: '/s/parent.jsonl', metadata: { origin: 'fork' } }))
    const parsed = parseHarnessV3Session(text)
    const transcript = readHarnessV3Transcript(text)

    expect(parsed.header).toStrictEqual({
      type: 'session',
      version: 3,
      id: 'hdr-id',
      timestamp: HEADER_TS,
      cwd: '/ws',
      parentSession: '/s/parent.jsonl',
      metadata: { origin: 'fork' }
    })
    expect(parsed.entries).toEqual([])
    expect(parsed.leafId).toBeNull()
    expect(parsed.issues).toEqual([])
    expect(transcript.header).toStrictEqual(parsed.header)
    expect(transcript.contextEntries).toEqual([])
    expect(transcript.runConfig).toEqual(NULL_RUN_CONFIG)
    expect(transcript.issues).toEqual([])
    expect(harnessV3TextToChatMessages(text, 'sid').messages).toEqual([])
  })

  it.each<[string, string]>([
    ['空文本', ''],
    ['只有空白行', '\n  \n\t\n'],
    ['非 JSON', 'not json\n'],
    ['null', 'null\n'],
    ['JSON 字符串', '"session"\n'],
    ['数组', '[]\n'],
    ['缺 type', jsonl({ version: 3, id: 'x', timestamp: HEADER_TS, cwd: '/ws' })],
    ['type 不是 session', jsonl(header({ type: 'sessionX' }))],
    ['version 2', jsonl(header({ version: 2 }))],
    ['version 4（pi 1.0 的格式必须拒绝）', jsonl(header({ version: 4 }))],
    ['version 是字符串 "3"', jsonl(header({ version: '3' }))],
    ['缺 id', jsonl({ type: 'session', version: 3, timestamp: HEADER_TS, cwd: '/ws' })],
    ['id 为空串', jsonl(header({ id: '' }))],
    ['id 是数字', jsonl(header({ id: 42 }))]
  ])('BP-2 头不可读（%s）→ HarnessV3FormatError，两个入口都抛', (_label, text) => {
    for (const run of [
      () => readHarnessV3Transcript(text),
      () => harnessV3TextToChatMessages(text, 'sid')
    ]) {
      let caught: unknown
      try {
        run()
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(HarnessV3FormatError)
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).name).toBe('HarnessV3FormatError')
    }
  })

  it.each<[string, Obj]>([
    ['cwd 为空串', header({ cwd: '' })],
    ['缺 cwd', (({ cwd: _c, ...rest }) => rest)(header())],
    ['cwd 是数字', header({ cwd: 42 })]
  ])('BP-3 %s → header.cwd 为 ""（照收，不拒绝）', (_label, head) => {
    const text = jsonl(head, u('a', null))
    const transcript = readHarnessV3Transcript(text)
    expect(transcript.header.cwd).toBe('')
    expect(ids(transcript.contextEntries)).toEqual(['a'])
    expect(transcript.issues).toEqual([])
  })

  it('BP-3 [白盒] 缺 timestamp → ""；非对象 metadata / 非字符串 parentSession 丢弃', () => {
    const noTs = (({ timestamp: _t, ...rest }) => rest)(header())
    expect(parseHarnessV3Session(jsonl(noTs)).header.timestamp).toBe('')

    for (const metadata of [['a'], null, 'str']) {
      const h = parseHarnessV3Session(jsonl(header({ metadata }))).header
      expect('metadata' in h, JSON.stringify(metadata)).toBe(false)
    }
    for (const parentSession of [42, null, { path: 'x' }]) {
      const h = parseHarnessV3Session(jsonl(header({ parentSession }))).header
      expect('parentSession' in h, JSON.stringify(parentSession)).toBe(false)
    }
  })

  it('BP-4 头之前的空行 / 空白行无妨', () => {
    const text = '\n   \n\t\n' + jsonl(header(), u('a', null), a('b', 'a'))
    const r = read(text)
    expect(r.branch).toEqual(['a', 'b'])
    expect(r.issues).toEqual([])
    expect(parseHarnessV3Session(text).header.id).toBe('hdr-id')
  })

  it('BP-5 未知条目类型：照收，推进 leaf，进分支与上下文，不产出消息', () => {
    const future = { type: 'future_thing', id: 'f', parentId: 'a', timestamp: ts(), x: 1 }
    const text = jsonl(header(), u('a', null), future)
    const r = read(text)
    expect(r.leafId).toBe('f')
    expect(r.branch).toEqual(['a', 'f'])
    expect(r.context).toEqual(['a', 'f'])
    expect(r.issues).toEqual([])
    expect(harnessV3TextToChatMessages(text, 'sid').messages.map((m) => m.id)).toEqual(['a'])
  })

  it('BP-6 条目上的多余字段原样进上下文', () => {
    const entry = { ...u('a', null), extra: { nested: [1, 2] }, another: 'x' }
    const transcript = readHarnessV3Transcript(jsonl(header(), entry))
    expect(transcript.contextEntries).toStrictEqual([entry])
  })

  it('BOM 开头的 UTF-8 BOM 去掉：与没有 BOM 的同一份文本输出相同，没有 issue', () => {
    const plain = jsonl(header(), u('a', null), a('b', 'a'))
    const withBom = '﻿' + plain
    expect(readHarnessV3Transcript(withBom)).toEqual(readHarnessV3Transcript(plain))
    expect(harnessV3TextToChatMessages(withBom, 'sid')).toEqual(
      harnessV3TextToChatMessages(plain, 'sid')
    )
    expect(readHarnessV3Transcript(withBom).issues).toEqual([])
  })
})

// ─── B2 当前位置（leaf） ──────────────────────────────────────────────────

describe('B2 当前位置', () => {
  it('BL-1 没有 leaf 条目：最后一条就是当前位置', () => {
    const r = read(jsonl(header(), u('A', null), a('B', 'A'), a('C', 'A')))
    expect(r.leafId).toBe('C')
    expect(r.branch).toEqual(['A', 'C'])
  })

  it('BL-2 回退之后接着写：新条目接在 leaf 指向处，回退掉的那条不在分支上', () => {
    const r = read(jsonl(header(), u('A', null), a('B', 'A'), leaf('L', 'B', 'A'), u('C', 'A')))
    expect(r.leafId).toBe('C')
    expect(r.branch).toEqual(['A', 'C'])
    expect(r.branch).not.toContain('B')
  })

  it('BL-3 关键回归：文件停在一条回退 leaf 上 → 回退掉的内容不重新冒出来', () => {
    const text = jsonl(header(), u('A', null), a('B', 'A'), u('C', 'B'), leaf('L', 'C', 'A'))
    const r = read(text)
    expect(r.leafId).toBe('A')
    expect(r.branch).toEqual(['A'])
    const messages = harnessV3TextToChatMessages(text, 'sid').messages
    expect(messages.map((m) => m.id)).toEqual(['A'])
  })

  it('BL-4 最后一行 leaf→null：分支 / 上下文 / 消息全空，运行配置全 null（之前的 model_change 不算）', () => {
    const text = jsonl(header(), mc('M', null, 'p', 'm'), u('A', 'M'), leaf('L', 'A', null))
    const transcript = readHarnessV3Transcript(text)
    expect(parseHarnessV3Session(text).leafId).toBeNull()
    expect(ids(branchOf(parseHarnessV3Session(text)).entries)).toEqual([])
    expect(transcript.contextEntries).toEqual([])
    expect(transcript.runConfig).toEqual(NULL_RUN_CONFIG)
    expect(transcript.issues).toEqual([])
    expect(harnessV3TextToChatMessages(text, 'sid').messages).toEqual([])
  })

  it('BL-5 leaf→null 之后起新根：分支只有新根那一支', () => {
    const r = read(
      jsonl(header(), u('A', null), a('B', 'A'), leaf('L', 'B', null), u('D', null), a('E', 'D'))
    )
    expect(r.branch).toEqual(['D', 'E'])
  })

  it('BL-6 连续几条 leaf：最后一条说了算', () => {
    const r = read(
      jsonl(
        header(),
        u('A', null),
        a('B', 'A'),
        u('C', 'B'),
        leaf('L1', 'C', 'B'),
        leaf('L2', 'B', 'A'),
        leaf('L3', 'A', 'C')
      )
    )
    expect(r.leafId).toBe('C')
    expect(r.branch).toEqual(['A', 'B', 'C'])
  })

  it('BL-7 leaf 指向更早的一条 leaf 条目：分支含那条 leaf 条目，并沿它的 parentId 往上走', () => {
    // 与 pi 一致（piCrossCheck X-13 对照过）：leaf 条目也是树上的一个节点，parentId 是写下它时的位置
    const r = read(
      jsonl(header(), u('A', null), a('B', 'A'), leaf('L1', 'B', 'A'), leaf('L2', 'A', 'L1'))
    )
    expect(r.leafId).toBe('L1')
    expect(r.branch).toEqual(['A', 'B', 'L1'])
    expect(r.issues).toEqual([])
  })

  it('BL-8 普通的回退里，分支上不会出现 leaf 条目', () => {
    const text = jsonl(
      header(),
      u('A', null),
      a('B', 'A'),
      u('C', 'B'),
      a('D', 'C'),
      leaf('L1', 'D', 'B'),
      u('E', 'B'),
      a('F', 'E'),
      leaf('L2', 'F', 'E'),
      a('G', 'E')
    )
    const branch = branchOf(parseHarnessV3Session(text)).entries
    expect(ids(branch)).toEqual(['A', 'B', 'E', 'G'])
    expect(branch.some((e) => e.type === 'leaf')).toBe(false)
  })
})

// ─── B3 分支 ──────────────────────────────────────────────────────────────

describe('B3 分支', () => {
  it('BB-1 根 → 叶，只取祖先，兄弟分支不在其中', () => {
    const r = read(jsonl(header(), u('A', null), a('B', 'A'), a('C', 'A'), u('D', 'C')))
    expect(r.branch).toEqual(['A', 'C', 'D'])
  })

  it('BB-2 parentId "" 视同根', () => {
    const r = read(jsonl(header(), u('A', null), a('B', '')))
    expect(r.branch).toEqual(['B'])
    expect(r.issues).toEqual([])
  })

  it('BB-3 重复 id：按 id 找时后一行胜出；X 的子条目走到后一个 X 的父条目', () => {
    const text = jsonl(
      header(),
      u('A', null),
      a('X', 'A', 'first X'),
      u('B', null),
      a('X', 'B', 'second X'),
      u('C', 'X')
    )
    const branch = branchOf(parseHarnessV3Session(text)).entries
    expect(ids(branch)).toEqual(['B', 'X', 'C'])
    const x = branch[1] as Extract<HarnessV3Entry, { type: 'message' }>
    expect((x.message.content as Array<{ text: string }>)[0].text).toBe('second X')
  })
})

// ─── B4 压缩过滤 ──────────────────────────────────────────────────────────

describe('B4 压缩过滤', () => {
  it('BC-1 没有压缩：上下文 = 分支', () => {
    const r = read(jsonl(header(), u('A', null), a('B', 'A'), mc('M', 'B', 'p', 'm'), u('C', 'M')))
    expect(r.context).toEqual(r.branch)
    expect(r.context).toEqual(['A', 'B', 'M', 'C'])
  })

  it('BC-2 [A,B,C,K(firstKept=B),D] → [K,B,C,D]', () => {
    const r = read(
      jsonl(header(), u('A', null), a('B', 'A'), u('C', 'B'), comp('K', 'C', 'B'), a('D', 'K'))
    )
    expect(r.context).toEqual(['K', 'B', 'C', 'D'])
  })

  it('BC-3 firstKept 是根 → 压缩之前的全部保留', () => {
    const r = read(
      jsonl(header(), u('A', null), a('B', 'A'), u('C', 'B'), comp('K', 'C', 'A'), a('D', 'K'))
    )
    expect(r.context).toEqual(['K', 'A', 'B', 'C', 'D'])
  })

  it.each<[string, string]>([
    ['不存在', 'nonexistent'],
    ['在别的分支上', 'S'],
    ['在压缩之后', 'D']
  ])('BC-4 firstKept %s → 之前一条都不保留：[K, D…]', (_label, firstKept) => {
    const r = read(
      jsonl(
        header(),
        u('A', null),
        a('S', 'A'),
        a('B', 'A'),
        u('C', 'B'),
        comp('K', 'C', firstKept),
        a('D', 'K'),
        u('E', 'D')
      )
    )
    expect(r.branch).toEqual(['A', 'B', 'C', 'K', 'D', 'E'])
    expect(r.context).toEqual(['K', 'D', 'E'])
  })

  it('BC-5 多次压缩只认最后一次：K2 的切点在 K1 之后 → K1 不在上下文里', () => {
    const r = read(
      jsonl(
        header(),
        u('A', null),
        a('B', 'A'),
        comp('K1', 'B', 'B'),
        u('C', 'K1'),
        comp('K2', 'C', 'C'),
        a('D', 'K2')
      )
    )
    expect(r.context).toEqual(['K2', 'C', 'D'])
  })

  it('BC-5 K2 的切点在 K1 之前 → K1 作为普通条目留着，投影出两张压缩摘要卡', () => {
    const text = jsonl(
      header(),
      u('A', null),
      a('B', 'A'),
      comp('K1', 'B', 'B'),
      u('C', 'K1'),
      comp('K2', 'C', 'B'),
      a('D', 'K2')
    )
    expect(read(text).context).toEqual(['K2', 'B', 'K1', 'C', 'D'])
    const summaries = harnessV3TextToChatMessages(text, 'sid').messages.filter(
      (m) => (m.metadata as { isCompactionSummary?: boolean } | null)?.isCompactionSummary
    )
    expect(summaries.map((m) => m.id)).toEqual(['K2', 'K1'])
  })

  it('BC-6 回退越过了一次压缩、又接着写：那次压缩不在分支上，完整分支就是上下文', () => {
    const r = read(
      jsonl(
        header(),
        u('A', null),
        a('B', 'A'),
        comp('K', 'B', 'B'),
        u('C', 'K'),
        leaf('L', 'C', 'A'),
        a('D', 'A'),
        u('E', 'D')
      )
    )
    expect(r.branch).toEqual(['A', 'D', 'E'])
    expect(r.context).toEqual(['A', 'D', 'E'])
  })

  it('BC-7 保留区里的非消息条目（model_change / custom / label）原位保留', () => {
    const r = read(
      jsonl(
        header(),
        u('A', null),
        mc('M', 'A', 'p', 'm'),
        custom('Cu', 'M', 'unknown:type', { x: 1 }),
        label('Lb', 'Cu', 'A'),
        a('B', 'Lb'),
        comp('K', 'B', 'M'),
        u('D', 'K')
      )
    )
    expect(r.context).toEqual(['K', 'M', 'Cu', 'Lb', 'B', 'D'])
  })

  it('contextEntriesOf 不改传入的分支数组', () => {
    const branch = branchOf(
      parseHarnessV3Session(jsonl(header(), u('A', null), comp('K', 'A', 'A'), a('B', 'K')))
    ).entries
    const before = [...branch]
    contextEntriesOf(branch)
    expect(branch).toEqual(before)
  })
})

// ─── B5 运行配置 ──────────────────────────────────────────────────────────

describe('B5 运行配置', () => {
  it('BR-1 没有切换条目 → 全 null（thinkingLevel 是 null，不是 "off"）', () => {
    const transcript = readHarnessV3Transcript(jsonl(header(), u('A', null), a('B', 'A')))
    expect(transcript.runConfig).toEqual(NULL_RUN_CONFIG)
  })

  it('BR-2 最后一条 model_change 说了算（provider 与 model 取自同一条）；thinking 各算各的', () => {
    const transcript = readHarnessV3Transcript(
      jsonl(
        header(),
        mc('M1', null, 'p1', 'm1'),
        tl('T1', 'M1', 'low'),
        mc('M2', 'T1', 'p2', 'm2'),
        u('A', 'M2'),
        tl('T2', 'A', 'high')
      )
    )
    expect(transcript.runConfig).toEqual({ provider: 'p2', model: 'm2', thinkingLevel: 'high' })
  })

  it('BR-3 压缩切点之前的 model_change 照样算（按分支算，不按上下文）；切点之后的 user 消息带它', () => {
    const text = jsonl(
      header(),
      mc('M', null, 'p1', 'm1'),
      u('A', 'M'),
      a('B', 'A'),
      u('C', 'B'),
      comp('K', 'C', 'C'),
      u('D', 'K')
    )
    const transcript = readHarnessV3Transcript(text)
    expect(ids(transcript.contextEntries)).toEqual(['K', 'C', 'D'])
    expect(transcript.runConfig).toEqual({ provider: 'p1', model: 'm1', thinkingLevel: null })
    const users = harnessV3TextToChatMessages(text, 'sid').messages.filter((m) => m.role === 'user')
    expect(users.map((m) => [m.id, m.model, m.provider])).toEqual([
      ['C', 'm1', 'p1'],
      ['D', 'm1', 'p1']
    ])
  })

  it('BR-4 被回退掉的那一支上的切换不算', () => {
    const transcript = readHarnessV3Transcript(
      jsonl(
        header(),
        u('A', null),
        mc('M', 'A', 'p', 'm'),
        tl('T', 'M', 'high'),
        leaf('L', 'T', 'A'),
        a('B', 'A')
      )
    )
    expect(transcript.runConfig).toEqual(NULL_RUN_CONFIG)
  })

  it('BR-5 assistant 消息自带的 provider / model 不进运行配置（与 pi 的 deriveSessionContextState 有意不同）', () => {
    const entries = parseHarnessV3Session(jsonl(header(), u('A', null), a('B', 'A'))).entries
    expect(runConfigOf(entries)).toEqual(NULL_RUN_CONFIG)
  })
})

// ─── B6 投影 ──────────────────────────────────────────────────────────────

describe('B6 投影', () => {
  it('BE-2 每条消息的 sessionId 是传入的参数，不是文件头里的 id', () => {
    const text = jsonl(
      header({ id: 'header-id' }),
      u('A', null),
      a('B', 'A'),
      comp('K', 'B', 'A'),
      u('C', 'K')
    )
    const messages = harnessV3TextToChatMessages(text, 'the-arg').messages
    expect(messages.length).toBeGreaterThan(2)
    for (const m of messages) expect(m.sessionId).toBe('the-arg')
  })
})

// ─── B7 宽容 ──────────────────────────────────────────────────────────────

describe('B7 宽容', () => {
  const T = HEADER_TS
  it.each<[string, string, RegExp]>([
    ['坏 JSON', '{"type":"message","id":', /JSON/],
    ['null', 'null', /entry/],
    ['数字', '42', /entry/],
    ['字符串', '"x"', /entry/],
    ['数组（缺 type）', '[]', /type/],
    ['缺 type', JSON.stringify({ id: 'Z', parentId: 'A', timestamp: T }), /type/],
    ['type 是数字', JSON.stringify({ type: 5, id: 'Z', parentId: 'A', timestamp: T }), /type/],
    ['缺 id', JSON.stringify({ type: 'message', parentId: 'A', timestamp: T }), /id/],
    ['id 为空串', JSON.stringify({ type: 'message', id: '', parentId: 'A', timestamp: T }), /id/],
    ['id 是数字', JSON.stringify({ type: 'message', id: 3, parentId: 'A', timestamp: T }), /id/],
    ['缺 parentId', JSON.stringify({ type: 'message', id: 'Z', timestamp: T }), /parentId/],
    [
      'parentId 是数字',
      JSON.stringify({ type: 'message', id: 'Z', parentId: 1, timestamp: T }),
      /parentId/
    ],
    ['缺 timestamp', JSON.stringify({ type: 'message', id: 'Z', parentId: 'A' }), /timestamp/],
    [
      'timestamp 为空串',
      JSON.stringify({ type: 'message', id: 'Z', parentId: 'A', timestamp: '' }),
      /timestamp/
    ],
    [
      'leaf 缺 targetId',
      JSON.stringify({ type: 'leaf', id: 'Z', parentId: 'A', timestamp: T }),
      /targetId/
    ],
    [
      'leaf 的 targetId 是数字',
      JSON.stringify({ type: 'leaf', id: 'Z', parentId: 'A', timestamp: T, targetId: 1 }),
      /targetId/
    ]
  ])(
    'BN-1 坏行（%s）夹在两条合法条目之间：跳过，别的不受影响，issue 记物理行号',
    (_l, bad, why) => {
      const text = jsonl(header(), u('A', null), bad, a('B', 'A'))
      const parsed = parseHarnessV3Session(text)
      expect(ids(parsed.entries)).toEqual(['A', 'B'])
      expect(parsed.leafId).toBe('B')
      const r = read(text)
      expect(r.branch).toEqual(['A', 'B'])
      expect(r.context).toEqual(['A', 'B'])
      expect(r.issues).toHaveLength(1)
      expect(r.issues[0].line).toBe(3)
      expect(r.issues[0].reason).toMatch(why)
    }
  )

  it('BN-2 物理行号把头和空行都算上', () => {
    // 头 1、空 2、合法 3、空 4、坏 5
    const text = [JSON.stringify(header()), '', JSON.stringify(u('A', null)), '  ', 'bad'].join(
      '\n'
    )
    expect(read(text).issues).toEqual([{ line: 5, reason: expect.stringMatching(/JSON/) }])

    // 头之前的空行同样占行号：空 1、空 2、头 3、合法 4、坏 5
    const shifted = ['', '', JSON.stringify(header()), JSON.stringify(u('A', null)), 'bad'].join(
      '\n'
    )
    expect(read(shifted).issues).toEqual([{ line: 5, reason: expect.stringMatching(/JSON/) }])
  })

  it('BN-3 截断的尾行（半行 JSON、没有换行）：跳过并记 issue；leaf 留在上一条合法行放的位置', () => {
    const partial = '{"type":"message","id":"C","parentId":"B","tim'
    const text = jsonl(header(), u('A', null), a('B', 'A')) + partial
    const r = read(text)
    expect(r.leafId).toBe('B')
    expect(r.branch).toEqual(['A', 'B'])
    expect(r.issues).toEqual([{ line: 4, reason: expect.stringMatching(/JSON/) }])

    // 上一条是 leaf 条目：位置是它的目标
    const afterLeaf = jsonl(header(), u('A', null), a('B', 'A'), leaf('L', 'B', 'A')) + partial
    const r2 = read(afterLeaf)
    expect(r2.leafId).toBe('A')
    expect(r2.branch).toEqual(['A'])
    expect(r2.issues).toEqual([{ line: 5, reason: expect.stringMatching(/JSON/) }])
  })

  it('BN-4 CRLF 与 LF 结果相同，没有 issue', () => {
    const lf = jsonl(
      header(),
      mc('M', null, 'p', 'm'),
      u('A', 'M'),
      a('B', 'A'),
      leaf('L', 'B', 'A'),
      u('C', 'A')
    )
    const crlf = lf.replace(/\n/g, '\r\n')
    expect(readHarnessV3Transcript(crlf)).toEqual(readHarnessV3Transcript(lf))
    expect(harnessV3TextToChatMessages(crlf, 'sid')).toEqual(harnessV3TextToChatMessages(lf, 'sid'))
    expect(readHarnessV3Transcript(crlf).issues).toEqual([])
  })

  it('BN-5 一条坏的 leaf 行（targetId: 5）不挪动当前位置，只记一条 issue', () => {
    const bad = { ...leaf('L', 'B', null), targetId: 5 }
    const r = read(jsonl(header(), u('A', null), a('B', 'A'), bad))
    expect(r.leafId).toBe('B')
    expect(r.branch).toEqual(['A', 'B'])
    expect(r.issues).toEqual([{ line: 4, reason: expect.stringMatching(/targetId/) }])
  })

  it('BN-6a leaf 指向从没出现过的条目：这条 leaf 不生效（位置留在 B），issue 记在那一行，没有 line 0', () => {
    const text = jsonl(header(), u('A', null), a('B', 'A'), leaf('L', 'B', 'ghost'))
    const parsed = parseHarnessV3Session(text)
    // leaf 条目本身仍在 entries 里
    expect(ids(parsed.entries)).toEqual(['A', 'B', 'L'])
    const r = read(text)
    expect(r.leafId).toBe('B')
    expect(r.branch).toEqual(['A', 'B'])
    expect(r.issues).toEqual([{ line: 4, reason: expect.stringContaining('ghost') }])
  })

  it('BN-6b 只有悬空的 leaf：位置是 null，分支为空，每条 leaf 一条 issue', () => {
    const r = read(jsonl(header(), leaf('L1', null, 'g1'), leaf('L2', null, 'g2')))
    expect(r.leafId).toBeNull()
    expect(r.branch).toEqual([])
    expect(r.issues).toEqual([
      { line: 2, reason: expect.stringContaining('g1') },
      { line: 3, reason: expect.stringContaining('g2') }
    ])
  })

  it('BN-6c 合法回退之后又来一条悬空 leaf：位置留在合法回退指向的 A', () => {
    const r = read(
      jsonl(
        header(),
        u('A', null),
        a('B', 'A'),
        u('C', 'B'),
        leaf('L1', 'C', 'A'),
        leaf('L2', 'A', 'ghost')
      )
    )
    expect(r.leafId).toBe('A')
    expect(r.branch).toEqual(['A'])
    expect(r.issues).toEqual([{ line: 6, reason: expect.stringContaining('ghost') }])
  })

  it('BN-6 指向一条在它**之后**才出现的条目，同样不生效', () => {
    const r = read(jsonl(header(), u('A', null), leaf('L', 'A', 'B'), a('B', 'A')))
    // leaf 不生效（位置停在 A），之后 B 自己推进位置
    expect(r.leafId).toBe('B')
    expect(r.branch).toEqual(['A', 'B'])
    expect(r.issues).toEqual([{ line: 3, reason: expect.stringContaining('B') }])
  })

  it('BN-7 leaf 指向一条自己那行坏掉被跳过的条目：与悬空同样处理，issue 排在坏行之后', () => {
    const badX = JSON.stringify({ type: 'message', id: 'X', parentId: 'B' })
    const r = read(jsonl(header(), u('A', null), a('B', 'A'), badX, leaf('L', 'B', 'X')))
    expect(r.leafId).toBe('B')
    expect(r.branch).toEqual(['A', 'B'])
    expect(r.issues).toEqual([
      { line: 4, reason: expect.stringMatching(/timestamp/) },
      { line: 5, reason: expect.stringContaining('X') }
    ])
  })

  it('BN-8 父条目那一行不在：分支停在缺口，issue 是 line 0、点名缺的那条', () => {
    const r = read(jsonl(header(), u('e-a', null), u('e-c', 'e-b')))
    expect(r.branch).toEqual(['e-c'])
    expect(r.context).toEqual(['e-c'])
    expect(r.issues).toEqual([{ line: 0, reason: expect.stringMatching(/e-b/) }])
  })

  it('BN-8 父条目那一行在但坏了：两条 issue —— 先是它的物理行，再是 line 0 的缺父', () => {
    const badB = JSON.stringify({ type: 'message', id: 'e-b', parentId: 'e-a', timestamp: '' })
    const r = read(jsonl(header(), u('e-a', null), badB, u('e-c', 'e-b')))
    expect(r.branch).toEqual(['e-c'])
    expect(r.issues).toEqual([
      { line: 3, reason: expect.stringMatching(/timestamp/) },
      { line: 0, reason: expect.stringMatching(/e-b/) }
    ])
  })

  it('BN-9 父链成环会停下：每条只出现一次，记一条 issue', () => {
    const loop = read(jsonl(header(), u('X', 'Y'), a('Y', 'X'), leaf('L', 'Y', 'X')))
    expect(loop.leafId).toBe('X')
    expect(loop.branch).toEqual(['Y', 'X'])
    expect(loop.issues).toHaveLength(1)
    expect(loop.issues[0].line).toBe(0)

    const self = read(jsonl(header(), u('Z', 'Z')))
    expect(self.branch).toEqual(['Z'])
    expect(self.issues).toHaveLength(1)
    expect(self.issues[0]).toMatchObject({ line: 0, reason: expect.stringContaining('Z') })
  }, 2000)

  it('BN-10 issue 的顺序：解析阶段的按行序，然后才是走分支时的', () => {
    const r = read(jsonl(header(), u('A', null), 'junk-1', u('C', 'missing'), 'junk-2'))
    expect(r.issues.map((i) => i.line)).toEqual([3, 5, 0])
    expect(r.issues[2].reason).toMatch(/missing/)
  })

  it('BN-11 幂等：同一份文本读两次，结果相等且互不影响', () => {
    const text = jsonl(
      header(),
      u('A', null),
      'junk',
      a('B', 'A'),
      comp('K', 'B', 'A'),
      u('C', 'K')
    )
    const first = readHarnessV3Transcript(text)
    const second = readHarnessV3Transcript(text)
    expect(second).toEqual(first)
    expect(second.issues).toHaveLength(1)

    // 改第一次的结果，第二、三次都不受影响（没有共享的可变状态、issue 不累积）
    ;(first.contextEntries[0] as { id: string }).id = 'mutated'
    first.issues.push({ line: 99, reason: 'mutated' })
    const third = readHarnessV3Transcript(text)
    expect(third).toEqual(second)
    expect(third.issues).toHaveLength(1)
    expect(ids(third.contextEntries)).toEqual(['K', 'A', 'B', 'C'])
  })
})

// ─── B8 其余 ──────────────────────────────────────────────────────────────

describe('B8 其余', () => {
  it('branchOf 是纯函数：两次结果相同，不改 session.issues', () => {
    const parsed = parseHarnessV3Session(
      jsonl(header(), u('A', null), 'junk', u('C', 'missing'), a('D', 'C'))
    )
    const issuesBefore = structuredClone(parsed.issues)
    expect(issuesBefore).toHaveLength(1)

    const once = branchOf(parsed)
    const twice = branchOf(parsed)
    expect(twice).toEqual(once)
    expect(ids(once.entries)).toEqual(['C', 'D'])
    expect(once.issues).toEqual([{ line: 0, reason: expect.stringMatching(/missing/) }])
    expect(parsed.issues).toEqual(issuesBefore)
    // 两次给的是各自的数组
    expect(twice.issues).not.toBe(once.issues)
  })

  it('BG-3 包根导出读取器的三个入口', async () => {
    const root = await import('../../../index')
    expect(typeof root.readHarnessV3Transcript).toBe('function')
    expect(typeof root.harnessV3TextToChatMessages).toBe('function')
    expect(typeof root.HarnessV3FormatError).toBe('function')
    expect(root.HarnessV3FormatError).toBe(HarnessV3FormatError)
  }, 30_000)
})
