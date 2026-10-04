/**
 * v3 读取器 × pi 0.80 的对照（**随 pi 一起删除**：本文件是唯一引 pi 的那一份，pi 退役时整个删掉；
 * 读取器自己的契约由 reader.test.ts / golden.test.ts 守着，它们一个 pi 的符号都不引）。
 *
 * 不变量：对一份 pi 能打开的合法文件，读取器的输出与 pi 逐条相同 —— 这是「旧会话现在怎么显示，
 * 以后就怎么显示」的根据。对照的五个面：当前位置、当前分支、经压缩过滤的上下文条目、
 * 运行配置（桌面 readSessionRunConfig 的口径：分支上最后一条显式切换）、投影出的界面消息。
 * oracle 一律把文本写进文件、用 `JsonlSessionStorage.open` **重开**再取（内存里刚 append 的条目
 * 还带着 undefined 字段，落盘再读回才是旧会话真正被看到的样子）。
 *
 *   X-1…X-12  每个 golden 场景都经 pi 的真 API 现建一份，两边逐面相等，读取器没有 issue
 *   X-13      pi 也收的手写文件：未知条目类型、重复 id、parentId ""、leaf 指向更早的 leaf 条目、
 *             firstKeptEntryId 在压缩之后、多余字段、CRLF、文件中间的空行、带 parentSession + metadata 的头
 *   X-14      定种子的随机操作序列（50 个种子 × 40 步，每 10 步对照一次）
 *   X-15      checked-in 的 fixture 忠于 pi：oracle 对每份 fixture 的输出等于它的 expected.json
 *   X-16      fixture 生成器（不是 CI 用例）：SHUVIX_WRITE_HARNESS_V3_GOLDEN=1 时才跑，
 *             expected.json 一律由 **pi** 算出，绝不由读取器算
 *   X-17      pi 拒开、读取器照收的三种文件：空 cwd、一行坏条目、截断的尾行
 *   BE-1      harnessV3TextToChatMessages = 读出的上下文条目 + 运行配置兜底 → 活路径上的同一个投影；
 *             issues 原样带出（放在这里而不是 reader.test.ts：它要引 harness/projection，那是 pi 时代的模块）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { JsonlSessionStorage, Session } from '@earendil-works/pi-agent-core'
import type { AgentMessage, SessionTreeEntry } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { entriesToChatMessages } from '../../../harness/projection'
import {
  branchOf,
  harnessV3TextToChatMessages,
  parseHarnessV3Session,
  readHarnessV3Transcript
} from '../index'

const SID = 'cross-check-sid'
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const GOLDEN_TIMESTAMP = '2026-01-01T00:00:00.000Z'

let dir: string
let env: NodeExecutionEnv
let fileSeq = 0

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-harness-v3-'))
  env = new NodeExecutionEnv({ cwd: dir })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─── 两边的五个面 ─────────────────────────────────────────────────────────

interface Faces {
  leafId: string | null
  branch: unknown[]
  contextEntries: unknown[]
  runConfig: { provider: string | null; model: string | null; thinkingLevel: string | null }
  messages: unknown[]
}

/** pi 的答案：写文件 → 重开 → 取五个面（消息按 sessionId 投影） */
async function oracle(text: string, sessionId = SID): Promise<Faces> {
  const path = join(dir, `oracle-${++fileSeq}.jsonl`)
  writeFileSync(path, text)
  const session = new Session(await JsonlSessionStorage.open(env, path))
  const branch = await session.getBranch()
  const contextEntries = await session.buildContextEntries()
  // 桌面 readSessionRunConfig 的口径：分支上最后一条显式切换
  const runConfig: Faces['runConfig'] = { provider: null, model: null, thinkingLevel: null }
  for (const entry of branch) {
    if (entry.type === 'model_change') {
      runConfig.provider = entry.provider
      runConfig.model = entry.modelId
    } else if (entry.type === 'thinking_level_change') {
      runConfig.thinkingLevel = entry.thinkingLevel
    }
  }
  return {
    leafId: await session.getLeafId(),
    branch,
    contextEntries,
    runConfig,
    messages: entriesToChatMessages(
      contextEntries,
      sessionId,
      runConfig.model ?? '',
      runConfig.provider ?? ''
    )
  }
}

/** 读取器的答案 */
function ours(text: string): Faces & { issues: unknown[] } {
  const parsed = parseHarnessV3Session(text)
  const transcript = readHarnessV3Transcript(text)
  return {
    leafId: parsed.leafId,
    branch: branchOf(parsed).entries,
    contextEntries: transcript.contextEntries,
    runConfig: transcript.runConfig,
    messages: harnessV3TextToChatMessages(text, SID).messages,
    issues: transcript.issues
  }
}

async function expectSameAsPi(text: string): Promise<void> {
  const expected = await oracle(text)
  const actual = ours(text)
  expect(actual.issues).toEqual([])
  expect(actual.leafId).toEqual(expected.leafId)
  expect(actual.branch).toEqual(expected.branch)
  expect(actual.contextEntries).toEqual(expected.contextEntries)
  expect(actual.runConfig).toEqual(expected.runConfig)
  expect(actual.messages).toEqual(expected.messages)
}

// ─── 经 pi 的真 API 建会话 ────────────────────────────────────────────────

const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function user(text: string, images: string[] = []): AgentMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((data) => ({ type: 'image', data, mimeType: 'image/png' }))
    ],
    timestamp: Date.now()
  } as AgentMessage
}

function assistant(
  content: unknown[],
  opts: { stopReason?: string; errorMessage?: string; provider?: string; model?: string } = {}
): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: opts.provider ?? 'test',
    model: opts.model ?? 'test-model',
    usage: USAGE,
    stopReason: opts.stopReason ?? 'stop',
    ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
    timestamp: Date.now()
  } as unknown as AgentMessage
}

const text = (t: string): unknown => ({ type: 'text', text: t })
const thinking = (t: string): unknown => ({ type: 'thinking', thinking: t })
const toolCall = (id: string, name = 'read', args: Record<string, unknown> = {}): unknown => ({
  type: 'toolCall',
  id,
  name,
  arguments: args
})

function toolResult(
  toolCallId: string,
  content: unknown[],
  opts: { isError?: boolean; details?: unknown; toolName?: string } = {}
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: opts.toolName ?? 'read',
    content,
    isError: opts.isError ?? false,
    ...(opts.details !== undefined ? { details: opts.details } : {}),
    timestamp: Date.now()
  } as AgentMessage
}

type Builder = (s: Session) => Promise<void>

/** 一问一答：返回 [user id, assistant id] */
async function turn(s: Session, q: string, a: string): Promise<[string, string]> {
  const u = await s.appendMessage(user(q))
  const r = await s.appendMessage(assistant([text(a)]))
  return [u, r]
}

/**
 * golden 场景（G01–G12）。名字即 fixture 文件名；golden.test.ts 里有一份同样的显式清单。
 * 改这里任何一个场景都要重跑生成器（X-16）。
 */
const SCENARIOS: Record<string, Builder> = {
  'G01-linear-basic': async (s) => {
    await s.appendModelChange('anthropic', 'claude-x')
    await s.appendThinkingLevelChange('medium')
    await s.appendMessage(user('你好，帮我看看这个项目'))
    await s.appendMessage(assistant([thinking('先想一想'), text('好的，我先读一下 README。')]))
    await s.appendMessage(user('读 README.md'))
    await s.appendMessage(
      assistant([text('读一下'), toolCall('call-1', 'read', { path: 'README.md' })], {
        stopReason: 'toolUse'
      })
    )
    await s.appendMessage(toolResult('call-1', [text('# Project\nhello')]))
    await s.appendMessage(assistant([text('README 只有一行标题。')]))
  },

  'G02-sidecars': async (s) => {
    await s.appendCustomMessageEntry('shuvix:instruction', 'Follow AGENTS.md', true, {
      filename: 'AGENTS.md'
    })
    await s.appendCustomMessageEntry('shuvix:instruction', 'hidden instruction', false, {
      filename: 'CLAUDE.md'
    })
    await s.appendCustomEntry('shuvix:inline_tokens', {
      content: 'review {{shuvixInlineToken:t1}} please',
      tokens: {
        t1: { type: 'at', id: 'src/a.ts', displayText: '@a.ts', payload: 'contents of a.ts' }
      }
    })
    await s.appendMessage(user('review contents of a.ts please'))
    await s.appendMessage(assistant([text('看过了。')]))
    await s.appendCustomEntry('shuvix:system_notice', {})
    await s.appendMessage(user('Background task finished: npm test exited 0'))
    await s.appendMessage(assistant([text('测试通过。')]))
    // 陈旧的内联侧车：紧随其后的不是 user 消息，下一条 user 不该吃到它
    await s.appendCustomEntry('shuvix:inline_tokens', {
      content: '{{shuvixInlineToken:t2}}',
      tokens: { t2: { type: 'cmd', id: 'review', displayText: '/review', payload: 'Review it' } }
    })
    await s.appendMessage(assistant([text('（自言自语）')]))
    await s.appendMessage(user('plain question'))
    await s.appendCustomEntry('someone-else:unknown', { anything: [1, 2, 3] })
    await s.appendMessage(user('<background-task id="t1">done</background-task>'))
    await s.appendMessage(assistant([text('收到。')]))
  },

  'G03-rollback-continue': async (s) => {
    const [, a1] = await turn(s, 'u1', 'a1')
    await turn(s, 'u2 (rolled back)', 'a2 (rolled back)')
    await s.moveTo(a1)
    const [, a3] = await turn(s, 'u3', 'a3')
    await turn(s, 'u4 (rolled back)', 'a4 (rolled back)')
    await s.moveTo(a3)
    await turn(s, 'u5', 'a5')
  },

  'G03b-rollback-tail': async (s) => {
    const [, a1] = await turn(s, 'u1', 'a1')
    await turn(s, 'u2 (rolled back)', 'a2 (rolled back)')
    await s.moveTo(a1)
  },

  'G04a-rollback-to-root-tail': async (s) => {
    await s.appendModelChange('anthropic', 'claude-x')
    await s.appendThinkingLevelChange('high')
    await turn(s, 'u1 (rolled back)', 'a1 (rolled back)')
    await s.moveTo(null)
  },

  'G04b-rollback-to-root-continue': async (s) => {
    await turn(s, 'u1 (rolled back)', 'a1 (rolled back)')
    await s.moveTo(null)
    await turn(s, 'u2', 'a2')
  },

  'G05-compaction-single': async (s) => {
    await s.appendModelChange('openai', 'gpt-x')
    await s.appendMessage(user('u1'))
    await s.appendMessage(assistant([toolCall('call-1')], { stopReason: 'toolUse' }))
    const tr = await s.appendMessage(toolResult('call-1', [text('result of call-1')]))
    await s.appendMessage(assistant([text('a1 final')]))
    await turn(s, 'u2', 'a2')
    // 切点落在一条 toolResult 上：它的 toolCall 被压缩掉了，投影里成了孤儿，静默丢弃
    await s.appendCompaction('summary of u1..a1', tr, 1234)
    await turn(s, 'u3', 'a3')
  },

  'G06a-compaction-multiple-later-cut': async (s) => {
    await turn(s, 'u1', 'a1')
    const [u2] = await turn(s, 'u2', 'a2')
    await s.appendCompaction('first summary', u2, 100)
    const [u3] = await turn(s, 'u3', 'a3')
    await s.appendCompaction('second summary', u3, 200)
    await turn(s, 'u4', 'a4')
  },

  'G06b-compaction-multiple-earlier-cut': async (s) => {
    await turn(s, 'u1', 'a1')
    const [u2] = await turn(s, 'u2', 'a2')
    await s.appendCompaction('first summary', u2, 100)
    await turn(s, 'u3', 'a3')
    // 第二次压缩的切点在第一次之前：第一次的摘要还在保留区里，显示成两张摘要卡
    await s.appendCompaction('second summary', u2, 200)
    await turn(s, 'u4', 'a4')
  },

  'G07-compaction-rolled-back': async (s) => {
    const [, a1] = await turn(s, 'u1', 'a1')
    const [u2] = await turn(s, 'u2', 'a2')
    await s.appendCompaction('summary on an abandoned branch', u2, 100)
    await turn(s, 'u3', 'a3')
    await s.moveTo(a1)
    await turn(s, 'u4', 'a4')
  },

  'G08-compaction-firstkept-missing': async (s) => {
    await turn(s, 'u1', 'a1')
    await s.appendCompaction('summary with a dangling cut', 'nonexistent', 100)
    await turn(s, 'u2', 'a2')
  },

  'G09-meta-entries': async (s) => {
    const [u1] = await turn(s, 'u1', 'a1')
    await s.appendLabel(u1, 'important')
    await s.appendSessionName('My session')
    // 元条目都留在最终分支上：投影要逐条跨过它们而不产出消息
    const tools = await s.appendActiveToolsChange(['read', 'bash'])
    await turn(s, 'u2 (abandoned)', 'a2 (abandoned)')
    await s.moveTo(tools, { summary: 'explored another approach', details: { files: ['x.ts'] } })
    await turn(s, 'u3', 'a3')
  },

  'G10-errors-images': async (s) => {
    await s.appendMessage(user('what is in this picture?', [PNG]))
    await s.appendMessage(
      assistant([], { stopReason: 'error', errorMessage: 'Connection error. (socket closed)' })
    )
    await s.appendMessage(user('retry'))
    // 首 token 前被中止：空卡不渲染
    await s.appendMessage(assistant([], { stopReason: 'aborted' }))
    await s.appendMessage(user('again'))
    await s.appendMessage(assistant([toolCall('call-1', 'bash', { command: 'false' })]))
    await s.appendMessage(
      toolResult('call-1', [text('exit 1')], {
        isError: true,
        toolName: 'bash',
        details: { exitCode: 1, sandbox: 'confined' }
      })
    )
    await s.appendMessage(assistant([toolCall('call-2', 'read', { path: 'a.png' })]))
    await s.appendMessage(
      toolResult('call-2', [text('image:'), { type: 'image', data: PNG, mimeType: 'image/png' }])
    )
    await s.appendMessage(assistant([text('图片里是一个像素。')]))
  },

  'G11-model-switch-midway': async (s) => {
    await s.appendModelChange('openai', 'gpt-x')
    await s.appendMessage(user('u1'))
    await s.appendMessage(assistant([text('a1')], { provider: 'openai', model: 'gpt-x' }))
    await s.appendModelChange('anthropic', 'claude-y')
    await s.appendMessage(user('u2'))
    await s.appendMessage(assistant([text('a2')], { provider: 'anthropic', model: 'claude-y' }))
  },

  'G12-header-only': async () => {}
}

/** 经 pi 建一份会话，回文件全文 */
async function build(builder: Builder): Promise<string> {
  const path = join(dir, `build-${++fileSeq}.jsonl`)
  const session = new Session(
    await JsonlSessionStorage.create(env, path, { cwd: dir, sessionId: `build-${fileSeq}` })
  )
  await builder(session)
  return readFileSync(path, 'utf8')
}

/** 头行换成确定的 id / cwd / timestamp（fixture 只有头部需要稳定，条目 id 就是 pi 当时给的） */
function normaliseHeader(text: string, name: string): string {
  const newline = text.indexOf('\n')
  const header = JSON.parse(text.slice(0, newline)) as Record<string, unknown>
  const normalised = { ...header, id: name, timestamp: GOLDEN_TIMESTAMP, cwd: '/fixture' }
  return JSON.stringify(normalised) + text.slice(newline)
}

// ─── 用例 ─────────────────────────────────────────────────────────────────

describe('X-1…X-12 golden 场景经 pi 现建，与 pi 逐面相等', () => {
  it.each(Object.keys(SCENARIOS))('%s', async (name) => {
    const text = await build(SCENARIOS[name])
    await expectSameAsPi(text)
  })
})

/** 手写文件的头 */
const H = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'session',
    version: 3,
    id: 'hand',
    timestamp: GOLDEN_TIMESTAMP,
    cwd: '/ws',
    ...over
  })
const TS = '2026-01-01T00:00:01.000Z'
const msgLine = (
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  t: string
): string =>
  JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: TS,
    message:
      role === 'user'
        ? { role: 'user', content: [{ type: 'text', text: t }], timestamp: 1 }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: t }],
            api: 'openai-completions',
            provider: 'p',
            model: 'm',
            usage: USAGE,
            stopReason: 'stop',
            timestamp: 2
          }
  })
const leafLine = (id: string, parentId: string | null, targetId: string | null): string =>
  JSON.stringify({ type: 'leaf', id, parentId, timestamp: TS, targetId })
const lines = (...ls: string[]): string => ls.join('\n') + '\n'

describe('X-13 pi 也收的手写文件', () => {
  it.each<[string, string]>([
    [
      '未知条目类型',
      lines(
        H(),
        msgLine('a', null, 'user', 'q'),
        JSON.stringify({ type: 'future_thing', id: 'f', parentId: 'a', timestamp: TS, x: 1 }),
        msgLine('b', 'f', 'assistant', 'r')
      )
    ],
    [
      '重复 id（后一行胜出）',
      lines(
        H(),
        msgLine('a', null, 'user', 'q'),
        msgLine('x', 'a', 'assistant', 'first x'),
        msgLine('b', null, 'user', 'q2'),
        msgLine('x', 'b', 'assistant', 'second x'),
        msgLine('c', 'x', 'user', 'q3')
      )
    ],
    [
      'parentId "" 视同根',
      lines(H(), msgLine('a', null, 'user', 'q'), msgLine('b', '', 'assistant', 'r'))
    ],
    [
      'leaf 指向更早的一条 leaf 条目',
      lines(
        H(),
        msgLine('a', null, 'user', 'q'),
        msgLine('b', 'a', 'assistant', 'r'),
        leafLine('l1', 'b', 'a'),
        leafLine('l2', 'a', 'l1')
      )
    ],
    [
      'firstKeptEntryId 在压缩之后',
      lines(
        H(),
        msgLine('a', null, 'user', 'q'),
        JSON.stringify({
          type: 'compaction',
          id: 'k',
          parentId: 'a',
          timestamp: TS,
          summary: 's',
          firstKeptEntryId: 'd',
          tokensBefore: 1
        }),
        msgLine('d', 'k', 'user', 'q2')
      )
    ],
    [
      '条目上的多余字段',
      lines(
        H(),
        JSON.stringify({
          ...JSON.parse(msgLine('a', null, 'user', 'q')),
          extra: { nested: [1, 2] },
          another: 'x'
        })
      )
    ],
    [
      'CRLF',
      lines(H(), msgLine('a', null, 'user', 'q'), msgLine('b', 'a', 'assistant', 'r')).replace(
        /\n/g,
        '\r\n'
      )
    ],
    [
      '文件中间的空行',
      [
        H(),
        '',
        msgLine('a', null, 'user', 'q'),
        '   ',
        '',
        msgLine('b', 'a', 'assistant', 'r'),
        ''
      ].join('\n')
    ],
    [
      '头带 parentSession 与 metadata',
      lines(
        H({ parentSession: '/sessions/parent.jsonl', metadata: { origin: 'fork', n: 1 } }),
        msgLine('a', null, 'user', 'q')
      )
    ]
  ])('%s', async (_label, text) => {
    await expectSameAsPi(text)
  })
})

// ─── X-14 定种子的随机操作序列 ────────────────────────────────────────────

/** mulberry32：小而确定的 PRNG */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function randomOp(
  s: Session,
  rand: () => number,
  callIds: string[],
  step: number
): Promise<void> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
  const entries = await s.getEntries()
  const r = rand()
  if (r < 0.2) {
    await s.appendMessage(user(`u${step}`, rand() < 0.1 ? [PNG] : []))
  } else if (r < 0.4) {
    const content: unknown[] = []
    if (rand() < 0.4) content.push(thinking(rand() < 0.2 ? '\n' : `think ${step}`))
    if (rand() < 0.7) content.push(text(`a${step}`))
    if (rand() < 0.3) {
      const id = `call-${step}`
      callIds.push(id)
      content.push(toolCall(id, pick(['read', 'bash', 'grep']), { n: step }))
    }
    const kind = rand()
    await s.appendMessage(
      kind < 0.1
        ? assistant(content, { stopReason: 'error', errorMessage: `boom ${step}` })
        : kind < 0.15
          ? assistant([], { stopReason: 'aborted' })
          : assistant(content, {
              provider: pick(['p1', 'p2']),
              model: pick(['m1', 'm2'])
            })
    )
  } else if (r < 0.5) {
    const id = callIds.length && rand() < 0.8 ? pick(callIds) : `orphan-${step}`
    await s.appendMessage(
      toolResult(id, [text(`result ${step}`)], {
        isError: rand() < 0.2,
        ...(rand() < 0.3 ? { details: { step } } : {})
      })
    )
  } else if (r < 0.58) {
    const kind = rand()
    if (kind < 0.4) {
      await s.appendCustomEntry('shuvix:inline_tokens', {
        content: `see {{shuvixInlineToken:k${step}}}`,
        tokens: {
          [`k${step}`]: { type: 'at', id: `f${step}`, displayText: `@f${step}`, payload: 'x' }
        }
      })
    } else if (kind < 0.7) {
      await s.appendCustomEntry('shuvix:system_notice', {})
    } else {
      await s.appendCustomEntry('unknown:type', { step })
    }
  } else if (r < 0.63) {
    await s.appendCustomMessageEntry('shuvix:instruction', `instr ${step}`, rand() < 0.5, {
      filename: 'AGENTS.md'
    })
  } else if (r < 0.68) {
    await s.appendModelChange(pick(['p1', 'p2', 'p3']), pick(['m1', 'm2', 'm3']))
  } else if (r < 0.72) {
    await s.appendThinkingLevelChange(pick(['off', 'low', 'medium', 'high']))
  } else if (r < 0.75) {
    await s.appendActiveToolsChange(rand() < 0.5 ? ['read'] : ['read', 'bash'])
  } else if (r < 0.83) {
    const branch = await s.getBranch()
    const source = rand()
    const firstKept =
      source < 0.6 && branch.length
        ? pick(branch).id
        : source < 0.85 && entries.length
          ? pick(entries).id
          : 'nonexistent'
    await s.appendCompaction(`summary ${step}`, firstKept, step * 10)
  } else if (r < 0.87) {
    if (entries.length)
      await s.appendLabel(pick(entries).id, rand() < 0.8 ? `label ${step}` : undefined)
  } else if (r < 0.9) {
    await s.appendSessionName(`name ${step}`)
  } else {
    const target = entries.length && rand() < 0.85 ? pick(entries).id : null
    await s.moveTo(target, rand() < 0.3 ? { summary: `branch summary ${step}` } : undefined)
  }
}

describe('X-14 定种子的随机操作序列', () => {
  it('50 个种子 × 40 步，每 10 步对照一次', async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rand = prng(seed)
      const path = join(dir, `fuzz-${seed}.jsonl`)
      const session = new Session(
        await JsonlSessionStorage.create(env, path, { cwd: dir, sessionId: `fuzz-${seed}` })
      )
      const callIds: string[] = []
      for (let step = 1; step <= 40; step++) {
        await randomOp(session, rand, callIds, step)
        if (step % 10 === 0) {
          try {
            await expectSameAsPi(readFileSync(path, 'utf8'))
          } catch (err) {
            throw new Error(`seed ${seed} step ${step}: ${(err as Error).message}`, { cause: err })
          }
        }
      }
    }
  }, 60_000)
})

// ─── X-15 / X-16 fixture ──────────────────────────────────────────────────

interface Expected {
  sessionId: string
  leafId: string | null
  branchIds: string[]
  contextEntryIds: string[]
  runConfig: Faces['runConfig']
  issues: unknown[]
  messages: unknown[]
}

/** pi 的五个面 → expected.json 的形状 */
function expectedFromPi(faces: Faces, sessionId: string): Expected {
  const idsOf = (entries: unknown[]): string[] => entries.map((e) => (e as SessionTreeEntry).id)
  return {
    sessionId,
    leafId: faces.leafId,
    branchIds: idsOf(faces.branch),
    contextEntryIds: idsOf(faces.contextEntries),
    runConfig: faces.runConfig,
    issues: [],
    messages: faces.messages
  }
}

describe('X-15 checked-in 的 fixture 忠于 pi', () => {
  const names = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''))
    .sort()

  it('fixture 目录不是空的', () => {
    expect(names.length).toBeGreaterThan(0)
  })

  it.each(names)('%s', async (name) => {
    const text = readFileSync(join(FIXTURE_DIR, `${name}.jsonl`), 'utf8')
    const expected = JSON.parse(
      readFileSync(join(FIXTURE_DIR, `${name}.expected.json`), 'utf8')
    ) as Expected
    // toEqual 而不是 toStrictEqual：JSON 落盘丢掉了 undefined 的键
    expect(expectedFromPi(await oracle(text, expected.sessionId), expected.sessionId)).toEqual(
      expected
    )
  })
})

describe('X-16 fixture 生成器（只在 SHUVIX_WRITE_HARNESS_V3_GOLDEN=1 时跑）', () => {
  it.runIf(process.env.SHUVIX_WRITE_HARNESS_V3_GOLDEN === '1')(
    '按 SCENARIOS 重写 fixtures/，expected.json 由 pi 算出',
    async () => {
      for (const [name, builder] of Object.entries(SCENARIOS)) {
        const text = normaliseHeader(await build(builder), name)
        // 与头里的 id 刻意不同：golden 顺带守住「消息带的是传进去的 sessionId」
        const sessionId = `sid-${name}`
        const expected = expectedFromPi(await oracle(text, sessionId), sessionId)
        writeFileSync(join(FIXTURE_DIR, `${name}.jsonl`), text)
        writeFileSync(
          join(FIXTURE_DIR, `${name}.expected.json`),
          JSON.stringify(expected, null, 2) + '\n'
        )
      }
    }
  )
})

// ─── X-17 / BE-1 ──────────────────────────────────────────────────────────

describe('X-17 pi 拒开、读取器照收', () => {
  it.each<[string, string, string[]]>([
    ['空 cwd', lines(H({ cwd: '' }), msgLine('a', null, 'user', 'q')), ['a']],
    [
      '一行坏条目',
      lines(
        H(),
        msgLine('a', null, 'user', 'q'),
        '{"type":"message"',
        msgLine('b', 'a', 'assistant', 'r')
      ),
      ['a', 'b']
    ],
    [
      '截断的尾行',
      lines(H(), msgLine('a', null, 'user', 'q')) +
        '{"type":"message","id":"b","parentId":"a","times',
      ['a']
    ]
  ])('%s', async (_label, text, ids) => {
    await expect(oracle(text)).rejects.toThrow()
    const view = harnessV3TextToChatMessages(text, SID)
    expect(view.messages.map((m) => m.id)).toEqual(ids)
  })
})

describe('BE-1 harnessV3TextToChatMessages = 读出的条目 + 运行配置兜底 → 活路径的投影', () => {
  it.each<[string, string]>([
    ['golden 场景 G05（压缩前的 model_change 只在运行配置里）', ''],
    [
      '带坏行与缺父条目的文件（issues 原样带出）',
      lines(
        H(),
        JSON.stringify({
          type: 'model_change',
          id: 'm',
          parentId: null,
          timestamp: TS,
          provider: 'p',
          modelId: 'mm'
        }),
        msgLine('a', 'm', 'user', 'q'),
        'not json',
        msgLine('c', 'gone', 'user', 'orphan'),
        msgLine('d', 'c', 'assistant', 'r')
      )
    ]
  ])('%s', async (label, handText) => {
    const text = handText || (await build(SCENARIOS['G05-compaction-single']))
    const transcript = readHarnessV3Transcript(text)
    const view = harnessV3TextToChatMessages(text, SID)

    expect(view.messages).toEqual(
      entriesToChatMessages(
        transcript.contextEntries as unknown as SessionTreeEntry[],
        SID,
        transcript.runConfig.model ?? '',
        transcript.runConfig.provider ?? ''
      )
    )
    expect(view.issues).toEqual(transcript.issues)
    if (handText) expect(view.issues.length, label).toBeGreaterThan(0)
  })
})
