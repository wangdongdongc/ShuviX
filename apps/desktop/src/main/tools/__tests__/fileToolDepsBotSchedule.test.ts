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
 *
 * 定时运行的权限核对（botAccessHint 注入的核对，这里是替身：forBotFile 回 ACCESS-BOT、forPolicyFile 回 ACCESS-POLICY）：
 *   FT-8  write / edit bot 文件 → 核对那段恰一次，接在排期之后、隔一个空行；核对拿到的是全文与绝对路径
 *   FT-9  点名 bot 的策略写进策略目录 → 核对那段恰一次（forPolicyFile(全文, basename)）；管网络又点名 bot 的 →
 *         policy check 那一句在前、核对在后，各一次；普通 md → 两样都没有
 *   FT-10 核对抛错 → 写入照样成功、没有核对那段
 *   （注入核对是模块级状态：每条用例之后复位成 null，FT-1…7 的期望只在没注入时成立；utils/paths 的替身要有
 *    getDefaultPoliciesDir，不然策略那侧的核对会悄悄缺席）
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
  policies: '',
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
  },
  getDefaultPoliciesDir: () => state.policies
}))
vi.mock('i18next', () => ({ default: { language: 'en', t: (key: string) => `i18n(${key})` } }))

import { makeWriteTool } from '../write'
import { makeEditTool } from '../edit'
import { makeReadTool } from '../read'
import { _resetAll } from '../../utils/toolUtils/fileTime'
import { setBotScheduleProjectLookup } from '../../services/botScheduleHint'
import { setBotAccessChecker } from '../../services/botAccessHint'
import type { BotAccessChecker } from '../../services/botAccessCheck'
import type { ToolContext } from '../../services/toolContext'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'

/** 内置策略 md 的构建期内联读取口（真实装配链要它；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

const ctx: ToolContext = { sessionId: SESSION_ID }
const savedTz = process.env.TZ

beforeAll(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-filetool-bot-schedule-'))
  state.bots = join(state.dir, 'bots')
  state.policies = join(state.dir, 'policies')
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
  setBotAccessChecker(null)
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

describe('桌面 write / edit — 定时运行的权限核对', () => {
  function stub(throws = false): {
    forBotFile: ReturnType<typeof vi.fn<BotAccessChecker['forBotFile']>>
    forPolicyFile: ReturnType<typeof vi.fn<BotAccessChecker['forPolicyFile']>>
    forBotName: ReturnType<typeof vi.fn<BotAccessChecker['forBotName']>>
  } {
    const fail = (): never => {
      throw new Error('policy scan failed')
    }
    const checker = {
      forBotFile: vi.fn<BotAccessChecker['forBotFile']>(throws ? fail : () => 'ACCESS-BOT'),
      forPolicyFile: vi.fn<BotAccessChecker['forPolicyFile']>(
        throws ? fail : () => 'ACCESS-POLICY'
      ),
      forBotName: vi.fn<BotAccessChecker['forBotName']>(() => ({ text: '' }))
    }
    setBotAccessChecker(checker)
    return checker
  }
  const accessCount = (out: string): number =>
    out.split('ACCESS-BOT').length - 1 + (out.split('ACCESS-POLICY').length - 1)

  /** 点名 bot buddy 的配套策略；network = 再加一条管网络主体的规则 */
  function namingPolicy(name: string, network = false): string {
    return [
      '---',
      'shuvix: policy v1',
      `name: ${name}`,
      'shuvix-policy-rules:',
      ...(network
        ? [
            '  - effect: deny',
            '    subject.kind: [network]',
            '    object.type: [request]',
            `    match: "!inCidr(subject.address, ['127.0.0.0/8'])"`
          ]
        : []),
      '  - effect: force-allow',
      '    subject.kind: [agent]',
      '    object.type: [session]',
      '    action: [read]',
      `    match: "has(subject.bot) && subject.bot == 'buddy' && subject.agentKind == 'root'"`,
      '---',
      '',
      'Companion policy.',
      ''
    ].join('\n')
  }

  it('FT-8 write / edit bot 文件 → 核对恰一次，接在排期之后、隔一个空行；拿到的是全文与绝对路径', async () => {
    const checker = stub()
    const p = join(state.bots, 'ft8.md')
    const written = await ok(makeWriteTool(ctx), { path: p, content: bot('20:00') })
    expect(written.endsWith(`\n\n${note('20:00')}\n\nACCESS-BOT`)).toBe(true)
    expect(accessCount(written)).toBe(1)
    expect(scheduleCount(written)).toBe(1)
    expect(checker.forBotFile.mock.calls).toEqual([[bot('20:00'), p]])
    expect(checker.forPolicyFile).not.toHaveBeenCalled()

    await ok(makeReadTool(ctx), { path: p })
    const edited = await ok(makeEditTool(ctx), {
      path: p,
      oldText: "event.local.time == '20:00'",
      newText: "event.local.time == '21:00'"
    })
    expect(edited.endsWith(`\n\n${note('21:00')}\n\nACCESS-BOT`)).toBe(true)
    expect(accessCount(edited)).toBe(1)
    expect(checker.forBotFile.mock.calls[1]).toEqual([bot('21:00'), p])
  })

  it('FT-9 点名 bot 的策略写进策略目录 → 核对恰一次（全文 + basename）', async () => {
    const checker = stub()
    const p = join(state.policies, 'buddy-access.md')
    const text = namingPolicy('buddy-access')
    const out = await ok(makeWriteTool(ctx), { path: p, content: text })
    expect(out.endsWith('\n\nACCESS-POLICY')).toBe(true)
    expect(accessCount(out)).toBe(1)
    expect(out).not.toContain('shuvix policy check')
    expect(checker.forPolicyFile.mock.calls).toEqual([[text, 'buddy-access.md']])
    expect(checker.forBotFile).not.toHaveBeenCalled()
  })

  it('FT-9 管网络又点名 bot 的策略 → policy check 那一句在前、核对在后，各一次', async () => {
    stub()
    const p = join(state.policies, 'net-and-bot.md')
    const out = await ok(makeWriteTool(ctx), {
      path: p,
      content: namingPolicy('net-and-bot', true)
    })
    const sentence = `\`shuvix policy check ${p}\``
    expect(out.split(sentence)).toHaveLength(2)
    expect(accessCount(out)).toBe(1)
    expect(out.indexOf(sentence)).toBeLessThan(out.indexOf('ACCESS-POLICY'))
    expect(out.endsWith('\n\nACCESS-POLICY')).toBe(true)
  })

  it('FT-9 普通 md（哪怕正文提到 subject.bot）→ 两样都没有', async () => {
    const checker = stub()
    const out = await ok(makeWriteTool(ctx), {
      path: join(state.dir, 'ft9-notes.md'),
      content: "# Notes\n\nsubject.bot == 'buddy'\n"
    })
    expect(accessCount(out)).toBe(0)
    expect(out).not.toContain('shuvix policy check')
    expect(checker.forBotFile).not.toHaveBeenCalled()
    expect(checker.forPolicyFile).not.toHaveBeenCalled()
  })

  it('FT-10 核对抛错 → 写入照样成功、没有核对那段（bot 文件的排期照给）', async () => {
    stub(true)
    const b = join(state.bots, 'ft10.md')
    const botOut = await ok(makeWriteTool(ctx), { path: b, content: bot('20:00') })
    expect(botOut.endsWith(`\n\n${note('20:00')}`)).toBe(true)
    expect(readFileSync(b, 'utf-8')).toBe(bot('20:00'))

    const p = join(state.policies, 'ft10-access.md')
    const policyOut = await ok(makeWriteTool(ctx), {
      path: p,
      content: namingPolicy('ft10-access')
    })
    expect(accessCount(policyOut)).toBe(0)
    expect(readFileSync(p, 'utf-8')).toBe(namingPolicy('ft10-access'))
  })
})
