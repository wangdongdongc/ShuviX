/**
 * 桌面文件工具 deps 的 `writtenNote`（fileToolDeps.ts）—— 写下一份 bot 文件，回执里附上它的定时接下来几次什么时候
 * 触发（services/botScheduleHint）；写下一份管网络的策略，回执里是 `shuvix policy check` 那一句（两者择一，策略优先）。
 * 真实临时文件 + 真实 fileTime + **真实安全模块**（同 fileToolDepsSessionDocument.test 的 provider 桩，整个临时目录
 * 在会话权限表里可写，不弹卡）+ 真实的写后处理；utils/paths 的替身把 bots 目录指到临时目录里。
 *
 * 时钟：只假 Date，定在**将来**（周六 2030-11-02 12:00:30，Asia/Shanghai）—— 读后被改守卫拿真实的 mtime 比
 * 读取时记下的（假的）时刻，定在过去的话 edit 会被判成「读过之后被改了」。
 *
 *   FT-1 write 一份合法的 bot 文件进 bots 目录 → 结果恰带一段 Schedule check，接在成功那句之后、隔一个空行
 *   FT-2 有写后处理的回执（v1 管线块的解析器警告）→ 那段在前，Schedule check 在后，隔一个空行，各一次
 *   FT-3 edit 把 20:00 改成 21:00 → 回执里是 21:00
 *   FT-4 管网络的策略 → policy check 那一句，没有 Schedule check
 *   FT-5 普通 md → 两样都没有
 *   FT-6 写坏的 bot（会话域埋点）→ INVALID 回执，没有 Schedule check
 *   FT-7 项目查找抛错 / getDefaultBotsDir 抛错 → 写入照样成功（前者排期照给、没有项目那一行；后者没有排期）
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { executeTool, resultText } from '@shuvix/agent-runtime/tools/testing/invokeTool'

const SESSION_ID = 'session-bot-schedule'

const state = vi.hoisted(() => ({
  dir: '',
  bots: '',
  botsThrows: false,
  requests: [] as InputRequest[]
}))

vi.mock('../../services/toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { sep: pathSep, join: joinPath } = await import('node:path')
  const makeContext = (): unknown =>
    createSecurityContext(
      { kind: 'agent', sessionId: 'session-bot-schedule', agentKind: 'root' },
      { host: 'desktop' },
      {
        host: 'desktop',
        pathSep,
        getVars: () => ({
          workspace: state.dir,
          toolResultsBase: joinPath(state.dir, '.nonexistent-tool-results'),
          skillsDirs: [],
          home: joinPath(state.dir, '.nonexistent-home'),
          systemDirs: [],
          // 整个临时目录「允许并记住」了写（写隐含读）：这里只看回执，不看询问
          aclRead: [state.dir],
          aclWrite: [state.dir]
        }),
        readBuiltinPolicyMd: INLINE_POLICY_MD,
        isDirectory: () => false,
        persistGrant: () => {},
        requestUserInput: async (req: InputRequest): Promise<InputResponse> => {
          state.requests.push(req)
          return { kind: 'ask', allowed: true }
        }
      }
    )
  return {
    resolveProjectConfig: () => ({ workingDirectory: state.dir }),
    getDesktopSecurityContext: makeContext,
    isSessionDocument: () => false,
    TOOL_ABORTED: 'Aborted'
  }
})
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../utils/paths', () => ({
  // 三个知识库根都指到不存在的目录：这里的写入不属于任何库
  getShuvixKnowledgeRootDir: () => join(state.dir, '.no-kb'),
  getUserKnowledgeRootDir: () => join(state.dir, '.no-kb-user'),
  getBuiltinKnowledgeDir: () => join(state.dir, '.no-kb-builtin'),
  getToolResultsDir: () => join(state.dir, 'tool_results'),
  getDefaultBotsDir: () => {
    if (state.botsThrows) throw new Error('no home')
    return state.bots
  }
}))
vi.mock('i18next', () => ({ default: { language: 'en', t: (key: string) => `i18n(${key})` } }))

import { makeWriteTool } from '../write'
import { makeEditTool } from '../edit'
import { makeReadTool } from '../read'
import { _resetAll } from '../../utils/toolUtils/fileTime'
import { setBotScheduleProjectLookup } from '../../services/botScheduleHint'
import type { ToolContext } from '../../services/toolContext'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'

/** 内置策略 md 的构建期内联读取口（真实装配链要它；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

const ctx: ToolContext = { sessionId: SESSION_ID }
const savedTz = process.env.TZ

beforeAll(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-filetool-bot-schedule-'))
  state.bots = join(state.dir, 'bots')
  mkdirSync(state.bots, { recursive: true })
})
afterAll(() => rmSync(state.dir, { recursive: true, force: true }))
beforeEach(() => {
  _resetAll()
  state.requests = []
  state.botsThrows = false
  process.env.TZ = 'Asia/Shanghai'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2030, 10, 2, 12, 0, 30))
})
afterEach(() => {
  vi.useRealTimers()
  setBotScheduleProjectLookup(undefined)
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

function bot(time: string, extra: string[] = [], marker = 'shuvix: bot v2'): string {
  return [
    '---',
    marker,
    'name: buddy',
    ...extra,
    'shuvix-bot-on:',
    '  - trigger: timer.fired',
    `    when: "event.local.time == '${time}'"`,
    '    message: Evening check-in.',
    "    project: 'Acme'",
    '---',
    '',
    'Persona.',
    ''
  ].join('\n')
}

const note = (time: string): string =>
  'Schedule check (local time, the next 14 days):\n' +
  `- binding #0 (timer.fired): next at Sat 2030-11-02 ${time}, Sun 2030-11-03 ${time}, Mon 2030-11-04 ${time}.`

/** 一次成功的工具调用的输出 */
async function ok(
  tool: Parameters<typeof executeTool>[0],
  params: Record<string, unknown>
): Promise<string> {
  const res = await executeTool(tool, 'ft', params as never)
  expect(res.isError, resultText(res)).toBeFalsy()
  return resultText(res)
}

const scheduleCount = (out: string): number => out.split('Schedule check').length - 1

describe('桌面 write / edit — bot 文件的排期回执', () => {
  it('FT-1 write 合法的 bot 文件进 bots 目录 → 恰一段 Schedule check，接在成功那句之后、隔一个空行', async () => {
    const p = join(state.bots, 'ft1.md')
    const out = await ok(makeWriteTool(ctx), { path: p, content: bot('20:00') })
    expect(scheduleCount(out)).toBe(1)
    expect(out.endsWith(`\n\n${note('20:00')}`)).toBe(true)
    expect(out.slice(0, out.indexOf('\n\nSchedule check'))).not.toContain('\n\n')
    expect(readFileSync(p, 'utf-8')).toBe(bot('20:00'))
  })

  it('FT-2 写后处理有话（v1 管线块的解析器警告）→ 那段在前、Schedule check 在后，隔一个空行，各一次', async () => {
    const p = join(state.bots, 'ft2.md')
    const out = await ok(makeWriteTool(ctx), {
      path: p,
      content: bot('20:00', ['shuvix-bot-pipeline:', '  - step: chat'], 'shuvix: bot v1')
    })
    const review = '[shuvix bot v1] Written with parser warnings:\n- '
    expect(out.split(review)).toHaveLength(2)
    expect(scheduleCount(out)).toBe(1)
    expect(out.indexOf(review)).toBeLessThan(out.indexOf('Schedule check'))
    expect(out).toContain(`shuvix-bot-pipeline' is no longer used`)
    expect(out.endsWith(`\n\n${note('20:00')}`)).toBe(true)
  })

  it('FT-3 edit 把 20:00 改成 21:00 → 回执里是 21:00', async () => {
    const p = join(state.bots, 'ft3.md')
    await ok(makeWriteTool(ctx), { path: p, content: bot('20:00') })
    await ok(makeReadTool(ctx), { path: p })
    const out = await ok(makeEditTool(ctx), {
      path: p,
      oldText: "event.local.time == '20:00'",
      newText: "event.local.time == '21:00'"
    })
    expect(scheduleCount(out)).toBe(1)
    expect(out.endsWith(`\n\n${note('21:00')}`)).toBe(true)
    expect(out).not.toContain('20:00')
  })

  it('FT-4 管网络的策略 → policy check 那一句，没有 Schedule check', async () => {
    const p = join(state.dir, 'policies', 'network-admission.md')
    const policy = [
      '---',
      'shuvix: policy v1',
      'name: network-admission',
      'shuvix-policy-scope: { subject.kind: [network] }',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    object.type: [request]',
      `    match: "!inCidr(subject.address, ['127.0.0.0/8'])"`,
      '    prompt: Not on the list.',
      '---',
      '',
      'Test policy.',
      ''
    ].join('\n')
    const out = await ok(makeWriteTool(ctx), { path: p, content: policy })
    expect(out).toContain(`\`shuvix policy check ${p}\``)
    expect(scheduleCount(out)).toBe(0)
  })

  it('FT-5 普通 md → 两样都没有', async () => {
    const out = await ok(makeWriteTool(ctx), {
      path: join(state.dir, 'notes.md'),
      content: '# Notes\n\nevent.local.time\n'
    })
    expect(scheduleCount(out)).toBe(0)
    expect(out).not.toContain('shuvix policy check')
  })

  it('FT-6 写坏的 bot（会话域埋点）→ INVALID 回执，没有 Schedule check', async () => {
    const broken = bot('20:00').replace(
      'shuvix-bot-on:\n',
      'shuvix-bot-on:\n  - trigger: session.turn-completed\n    message: Hi.\n'
    )
    const out = await ok(makeWriteTool(ctx), { path: join(state.bots, 'ft6.md'), content: broken })
    expect(out).toContain('[shuvix bot v2] The file was written, but it is INVALID')
    expect(scheduleCount(out)).toBe(0)
  })

  it('FT-7 项目查找抛错 → 写入成功、排期照给、没有项目那一行；getDefaultBotsDir 抛错 → 写入成功、没有排期', async () => {
    setBotScheduleProjectLookup(() => {
      throw new Error('database closed')
    })
    const p = join(state.bots, 'ft7.md')
    const out = await ok(makeWriteTool(ctx), { path: p, content: bot('20:00') })
    expect(out.endsWith(`\n\n${note('20:00')}`)).toBe(true)
    expect(out).not.toContain('project')

    // 对照：查找回 0 → 那一行在（证明上面那条确实带着 project）
    setBotScheduleProjectLookup(() => 0)
    const withLine = await ok(makeWriteTool(ctx), {
      path: join(state.bots, 'ft7b.md'),
      content: bot('20:00')
    })
    expect(withLine).toContain('no project is named "Acme"')

    state.botsThrows = true
    const q = join(state.bots, 'ft7c.md')
    const noDir = await ok(makeWriteTool(ctx), { path: q, content: bot('20:00') })
    expect(scheduleCount(noDir)).toBe(0)
    expect(readFileSync(q, 'utf-8')).toBe(bot('20:00'))
  })
})
