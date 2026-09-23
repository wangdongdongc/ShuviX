/**
 * TOS —— 工具**声明**的截断策略，一路走到「模型最后看到的那段文字」。
 *
 * 这条链上每一环都早有单测：三个截法自己（shared/node/__tests__/truncate.test.ts）、后处理内核
 * （toolOutput/__tests__/spill.test.ts）、宿主怎么装配（agents/__tests__/toolOutputSpill.test.ts）。
 * 唯独没人从头走到尾问一句：`read` 声明「保留开头」，超限之后模型手里剩下的到底是不是文件的开头。
 * 策略名曾经叫 head / tail —— 声明的一侧与执行截断的一侧各读了一种意思，`read` 于是保留的是文件
 * **末尾**，而每一环的单测都是绿的。这一组补的就是这个缺口。
 *
 * 因此这里只断言**幸存的文字**（开头那几行在不在、末尾那几行在不在），不与任何 helper 的返回值
 * 对照：`expect(body).toBe(truncateKeepStart(...).text)` 那种写法，可以被「把红的改绿」的人原地
 * 换成另一个 helper —— 当初漏掉这个 bug 的正是这种写法。
 *
 * 脚手架照搬 tools/__tests__/read.test.ts 的 mock 头（四个工具在 import 期碰到的模块都在里面），
 * 但**不 mock fs**：TOS-4 / TOS-5 要的正是「真的 read 读真的文件」。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-tos-test-' + Date.now())
/** 假 userData —— 落盘走真实的 utils/paths.ts（getToolResultsDir），必须给它一个真目录 */
const USER_DATA_DIR = join(tmpdir(), 'shuvix-tos-userdata-' + Date.now())
const SID = 'tos-session'

// mock toolContext（避免加载 projectDao/sessionService → electron app.getPath）
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({
    workingDirectory: TEST_DIR,
    referenceDirs: []
  }),
  isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
    const resolved = resolve(absolutePath)
    const base = resolve(workingDirectory)
    return resolved === base || resolved.startsWith(base + sep)
  },
  isPathWithinReferenceDirs: () => false,
  assertReadAllowed: () => {},
  assertWriteAllowed: () => {},
  // 共享 createFileToolSuite 经此 security 门面走统一评估；测试里恒放行（询问 no-op）
  getDesktopSecurityContext: () => ({
    evaluate: () => ({ effect: 'allow', matched: [], winning: 'test' }),
    evaluateReadOnly: () => true,
    enforcePath: async () => {},
    enforceCommand: async () => ({ status: 'allowed' }),
    enforceGitOp: async () => {}
  }),
  TOOL_ABORTED: 'Aborted'
}))

// mock toolRegistry — 各工具文件底部的 registerBuiltinTool 在测试里是 no-op
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: () => {}
}))

// mock electron — read.ts 需要 nativeImage（图片分支，这里用不到）与 app.getPath（落盘目录）
vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA_DIR, isPackaged: false },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) }
}))

// mock i18n — 返回 key 本身（带参数展开）
vi.mock('../../i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) => {
    if (!params) return key
    let result = key
    for (const [k, v] of Object.entries(params)) {
      result += ` ${k}=${v}`
    }
    return result
  }
}))

// mock logger
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {}
  })
}))

// mock markitdown-ts 和 word-extractor（避免不必要的加载）
vi.mock('markitdown-ts', () => ({
  MarkItDown: class {
    async convert(): Promise<{ title: string | null; markdown: string } | null> {
      return { title: null, markdown: '' }
    }
  }
}))
vi.mock('word-extractor', () => ({
  default: class {
    extract(): { getBody: () => string } {
      return { getBody: () => '' }
    }
  }
}))

import type { TSchema } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { makeReadTool } from '../read'
import { ListTool } from '../ls'
import { GlobTool } from '../glob'
import { GrepTool } from '../grep'
import { getOutputStrategy, wrapToolOutput } from '../../services/wrapToolOutput'
import type { ToolContext } from '../../services/toolContext'

const ctx: ToolContext = { sessionId: SID }

/** 3000 行、每行唯一 —— 任何一档缺省上限下都必然超行数（同 spill.test.ts 的 BIG） */
const BIG = Array.from({ length: 3000 }, (_, i) => `L${String(i).padStart(4, '0')}`).join('\n')

/** 表头 / 指路之后的正文（第一个空行之后的全部）—— 同 processToolOutput.test.ts 的写法 */
const bodyOf = (text: string): string => text.slice(text.indexOf('\n\n') + 2)

/** 工具结果里交给模型的那段文字 */
function textOf(result: AgentToolResult<unknown>): string {
  const block = result.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}

/**
 * agentHost.resolveTools 给每个工具做的那一层包装，原样重放：策略与上限都取**工具自己的**声明，
 * 其余（processToolOutput → truncate*）全是真的。
 */
function hostWrap(tool: object, spill: boolean): AgentTool<TSchema, unknown> {
  const caps = tool as { outputMaxBytes?: number; outputMaxLines?: number }
  return wrapToolOutput(tool as AgentTool<TSchema, unknown>, SID, getOutputStrategy(tool), {
    maxBytes: caps.outputMaxBytes,
    maxLines: caps.outputMaxLines,
    spill
  })
}

/**
 * 工具本体换成一个只回 `text` 的探针 —— 原型仍是**真工具**，声明的 outputStrategy / outputMax*
 * 一并继承，于是「声明什么」与「剩下什么」之间没有第二份副本。
 */
async function hostRun(tool: object, text: string, opts: { spill: boolean }): Promise<string> {
  const probe = Object.create(tool) as AgentTool<TSchema, unknown>
  Object.defineProperty(probe, 'execute', {
    value: async () => ({ content: [{ type: 'text' as const, text }], details: undefined }),
    writable: true,
    enumerable: true,
    configurable: true
  })
  return textOf(await hostWrap(probe, opts.spill).execute('tos-call', {}))
}

/** 真文件：2500 行、每行唯一 —— 超过 read 自己的 2000 行封顶，于是结果里必带续读提示 */
const REAL_FILE = join(TEST_DIR, 'big.txt')
const REAL_LINE = (i: number): string => `F${String(i).padStart(4, '0')}`

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(REAL_FILE, Array.from({ length: 2500 }, (_, i) => REAL_LINE(i)).join('\n'), 'utf-8')
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

/** 真的 read 读真的文件，再过一遍宿主那一层 —— 全链路一处桩都没有 */
async function realRead(): Promise<string> {
  const read = makeReadTool(ctx)
  return textOf(await hostWrap(read, false).execute('tos-real-read', { path: REAL_FILE }))
}

describe('TOS 声明「保留开头」的工具', () => {
  const rows: [string, () => object][] = [
    ['read', () => makeReadTool(ctx)],
    ['ls', () => new ListTool(ctx)],
    ['glob', () => new GlobTool(ctx)],
    ['grep', () => new GrepTool(ctx)]
  ]

  it.each(rows)('TOS-1 %s 超限之后模型拿到的是开头', async (_name, make) => {
    const body = bodyOf(await hostRun(make(), BIG, { spill: false }))

    expect(body.startsWith('L0000'), body.slice(0, 40)).toBe(true)
    expect(body).not.toContain('L2999')
  })
})

describe('TOS 没声明策略的工具', () => {
  it('TOS-2 走 `?? middle` 兜底：首尾都在，中间没了', async () => {
    // MCP / skill 工具就是这个形状：一个带 name 的普通对象，没有 outputStrategy
    const tool = { name: 'mcp__probe__dump' }

    const body = bodyOf(await hostRun(tool, BIG, { spill: false }))

    expect(body.startsWith('L0000'), body.slice(0, 40)).toBe(true)
    expect(body).toContain('L2999')
    expect(body).not.toContain('L1500')
  })
})

describe('TOS 落盘之后的预览', () => {
  it('TOS-3 read 落盘时，正文里那段预览同样从开头起', async () => {
    const text = await hostRun(makeReadTool(ctx), BIG, { spill: true })

    expect(text).toContain('[Full output saved to: ')
    const body = bodyOf(text)
    expect(body.startsWith('L0000'), body.slice(0, 40)).toBe(true)
    // 预览封顶 200 行：第 200 行还在
    expect(body).toContain('L0199')
    expect(body).not.toContain('L2999')
  })
})

describe('TOS 真的 read 读真的文件', () => {
  it('TOS-4 模型拿到的第一行就是文件的第一行', async () => {
    const first = bodyOf(await realRead()).split('\n')[0]

    // readTextContent 给每行加了行号（分隔符是 U+2502，不是竖线），宽度按总行数右对齐
    expect(first.trimStart()).toBe(`1│${REAL_LINE(0)}`)
  })

  it('TOS-5 2000 行封顶的 read 仍带着续读提示', async () => {
    const text = await realRead()

    // read 自己把正文截到 2000 行、末尾附上这句 —— 「接着用 offset 往下读」正是 keep-start 的
    // 理由，它要是被宿主的行数上限砍掉，keep-start 就只剩前一半意思了
    expect(text).toContain('Use offset=2001 to continue.')
    expect(bodyOf(text).split('\n')[0].trimStart()).toBe(`1│${REAL_LINE(0)}`)
  })
})
