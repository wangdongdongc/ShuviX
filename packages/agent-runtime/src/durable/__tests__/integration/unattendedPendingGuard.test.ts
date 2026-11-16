/**
 * 守卫：无人值守的一轮里挂起表恒空（docs/unattended-run-design.md §3「保证」）。
 *
 * 真 `DurableSession` + 脚本化模型 + 真 `ask` 工具 + 真 write 工具（真安全模块的执行点：空权限表下每次写都问）
 * + 可控的审查接缝。任何发问方绕过 `DurableSession.requestUserInput` 这一个拦点、直接进了挂起表，UG-1 都会抓到。
 *
 *   UG-1   触发器开的一轮里依次：`ask`、写（没有审查意见）、写（审查答 ask）、写（审查放行）、写（审查拒绝）、
 *          同一轮并行的 `ask` + 写 —— `PendingInputRequests.request` 一次都没被调，订阅询问的钩子一次都没被调，
 *          这一轮跑到最终回答；被拒的每一步都是无人值守的文字（审查放行的那步真的写了，审查拒绝的是审查员的话）
 *   UG-1b  对照：同一份脚本由人开启时，第一步就挂在卡片上（守卫不是空转）
 *   UG-1c  运行途中人接手：接手之前的那步被拒，之后的那步出卡片
 *   UG-2   静态守卫：产品代码里凡是自己查看询问应答的取消分支的文件，都认 `reason === 'unattended'`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import {
  isUnattendedResult,
  UNATTENDED_QUESTION_TEXT,
  unattendedApprovalText
} from '@shuvix/chat-protocol/unattended'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSessionDecisions } from '../../../security/decisionLog'
import type { PermissionRequestEvent, PermissionReviewAnswer } from '../../../security/types'
import { executeTool, failureText } from '../../../tools/testing/invokeTool'
import { PendingInputRequests } from '../../inputRequests'
import { answer, callTool } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { waitFor, withTimeout } from '../support/wait'
import { resultEntry, resultMessage, resultText } from './support/entries'
import { memFs } from './support/memFs'
import { fileSuite, securityFor } from './support/realTools'
import { callTools, lines } from './support/scriptedModel'
import { allow, choose, makeWorld, nextInput, registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
afterEach(() => vi.restoreAllMocks())

const TIMEOUT = 20000
const TRIGGER = { kind: 'trigger', trigger: 'timer.fired', bot: 'b' } as const
const LOCAL = { kind: 'local' } as const
const UNATTENDED: InputResponse = { kind: 'cancel', reason: 'unattended' }

const ASK_ARGS = {
  question: 'Q',
  options: [
    { label: 'A', description: 'first' },
    { label: 'B', description: 'second' }
  ]
}
const write = (name: string): { path: string; content: string } => ({ path: name, content: 'X' })

/** 审查接缝：按被写的文件名回答（没列的 = 没有意见，照旧交给人） */
function reviewByFile(event: PermissionRequestEvent): Promise<PermissionReviewAnswer | null> {
  const path = String((event.request.object as { path?: unknown }).path ?? '')
  const decision = path.endsWith('ask.txt')
    ? 'ask'
    : path.endsWith('allow.txt')
      ? 'allow'
      : path.endsWith('deny.txt')
        ? 'deny'
        : undefined
  if (decision === undefined) return Promise.resolve(null)
  return Promise.resolve({
    verdict: {
      decision,
      risk: 'low',
      summary: 'writes a file',
      reason: `reviewer says ${decision}`
    },
    source: 'auto-review'
  })
}

/** 直接调一次真 write，卡片回「没人在」：模型在无人值守时该读到的那段话 */
async function refusedWriteText(name: string): Promise<string> {
  const suite = fileSuite(
    memFs({}),
    securityFor('direct-unattended', async () => UNATTENDED)
  )
  return failureText(executeTool(suite.write, 'c-direct', write(name)))
}

const SCRIPT = [
  callTool('ask', ASK_ARGS, 'c-ask'),
  callTool('write', write('plain.txt'), 'c-plain'),
  callTool('write', write('ask.txt'), 'c-rask'),
  callTool('write', write('allow.txt'), 'c-rallow'),
  callTool('write', write('deny.txt'), 'c-rdeny'),
  callTools(['ask', ASK_ARGS, 'c-ask2'], ['write', write('second.txt'), 'c-plain2']),
  answer('all done')
]

describe('guard · the pending table stays empty through an unattended run', () => {
  it(
    'UG-1 every asker in a trigger-started run is refused at the choke point: nothing is ever pending and the run reaches its final answer',
    async () => {
      const world = await makeWorld({ toolHost: () => ({ review: reviewByFile }) })
      const session = await world.open()
      const request = vi.spyOn(PendingInputRequests.prototype, 'request')
      const counts: number[] = []
      const sampler = setInterval(() => counts.push(session.pendingInputCount), 1)

      world.chat(...SCRIPT)
      try {
        expect(
          await withTimeout(session.submitUser('tick', { source: TRIGGER }), 15000, 'run')
        ).toEqual({})
      } finally {
        clearInterval(sampler)
      }

      // 拦点之后的那张表根本没被碰过
      expect(request).not.toHaveBeenCalled()
      expect(world.t.asks).toEqual([])
      expect(counts.every((count) => count === 0)).toBe(true)
      expect(session.pendingInputCount).toBe(0)
      expect(session.unattended).toBe(true)

      const conversation = await session.currentConversation()
      const text = async (id: string): Promise<string> =>
        resultText(await resultEntry(conversation, id))
      const failed = async (id: string): Promise<boolean> =>
        resultMessage(await resultEntry(conversation, id)).isError === true

      // 提问：普通结果，不是红行
      expect(await text('c-ask')).toBe(UNATTENDED_QUESTION_TEXT)
      expect(await failed('c-ask')).toBe(false)
      expect(await text('c-ask2')).toBe(UNATTENDED_QUESTION_TEXT)

      // 权限：失败的一步，文字与直接调一次真工具得到的一字不差
      for (const [id, name] of [
        ['c-plain', 'plain.txt'],
        ['c-rask', 'ask.txt'],
        ['c-plain2', 'second.txt']
      ] as const) {
        const refused = await text(id)
        expect(refused).toBe(await refusedWriteText(name))
        expect(isUnattendedResult(refused)).toBe(true)
        expect(refused.split('\n')[0]).toContain(name)
        expect(await failed(id)).toBe(true)
        expect(world.fs.files.has(`/ws/${name}`)).toBe(false)
      }

      // 审查放行的照常做成；审查拒绝的是审查员的话
      expect(await failed('c-rallow')).toBe(false)
      expect(world.fs.files.get('/ws/allow.txt')).toBe('X')
      expect(await text('c-rdeny')).toMatch(/^Blocked by the reviewer: reviewer says deny/)
      expect(isUnattendedResult(await text('c-rdeny'))).toBe(false)
      expect(world.fs.files.has('/ws/deny.txt')).toBe(false)

      // 模型读到了这些话，并跑到了最终回答
      const seen = lines(world.model.chats.at(-1)!)
      expect(seen).toContain(`toolResult:${UNATTENDED_QUESTION_TEXT}`)
      expect(seen.filter((line) => line.startsWith('toolResult:[Unattended run]'))).toHaveLength(5)
      expect(seen.some((line) => line === 'toolResult:Aborted')).toBe(false)

      // 决策日志：没人在 ≠ 用户拒绝
      const responses = getSessionDecisions('s1').map((log) => log.userResponse)
      expect(responses.filter((response) => response === 'unattended')).toHaveLength(3)
      expect(responses).not.toContain('denied')
      expect(responses).not.toContain('cancel')
    },
    TIMEOUT
  )

  it(
    'UG-1b control: the same script started by a person stops on a card at its first step',
    async () => {
      const world = await makeWorld({ toolHost: () => ({ review: reviewByFile }) })
      const session = await world.open()
      const request = vi.spyOn(PendingInputRequests.prototype, 'request')
      world.chat(callTool('ask', ASK_ARGS, 'c-ask'), answer('done'))
      const sending = session.submitUser('go', { source: LOCAL })
      await nextInput(world, 'c-ask')
      expect(session.pendingInputCount).toBe(1)
      expect(request).toHaveBeenCalledTimes(1)
      choose(world, 'c-ask', ['A'])
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
      expect(lines(world.model.chats.at(-1)!)).toContain('toolResult:User selected: A')
    },
    TIMEOUT
  )

  it(
    'UG-1c a person taking over mid-run: the step before is refused, the step after shows its card and runs once allowed',
    async () => {
      const world = await makeWorld({ toolHost: () => ({ review: reviewByFile }) })
      const session = await world.open()
      world.chat(
        callTool('write', write('before.txt'), 'c-before'),
        // 模型读到第一步被拒的那一刻，用户点了「我在这儿」
        () => {
          session.attend()
          return callTool('write', write('after.txt'), 'c-after')
        },
        answer('done')
      )
      const sending = session.submitUser('tick', { source: TRIGGER })
      await nextInput(world, 'c-after')
      expect(session.unattended).toBe(false)
      expect(session.pendingInputCount).toBe(1)
      allow(world, 'c-after')
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})

      const conversation = await session.currentConversation()
      expect(resultText(await resultEntry(conversation, 'c-before'))).toBe(
        await refusedWriteText('before.txt')
      )
      expect(world.fs.files.has('/ws/before.txt')).toBe(false)
      expect(world.fs.files.get('/ws/after.txt')).toBe('X')
      await waitFor(() => !session.isBusy(), 2000, 'idle')
    },
    TIMEOUT
  )
})

// ─────────────────────────── UG-2 静态守卫 ───────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../../../..')
const SCAN_ROOTS = ['packages/agent-runtime/src', 'apps/desktop/src/main']

function productFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'testing' || name === 'node_modules') continue
      productFiles(full, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('guard · every asker that reads the answer knows the unattended reason', () => {
  it('UG-2 a product file that calls the ask channel and branches on a cancelled answer also handles reason unattended', () => {
    const calls = /\brequestUserInput(For)?\s*\(/
    const inspectsCancel = /\.kind\s*===\s*'cancel'/
    const handlesUnattended = /\.reason\s*===\s*'unattended'/

    const inspecting: string[] = []
    const missing: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of productFiles(join(REPO, root))) {
        const source = readFileSync(file, 'utf8')
        if (!calls.test(source) || !inspectsCancel.test(source)) continue
        const name = relative(REPO, file).split('\\').join('/')
        inspecting.push(name)
        if (!handlesUnattended.test(source)) missing.push(name)
      }
    }

    expect(missing).toEqual([])
    // 今天自己查看应答的三个发问方；其余调用点只转交 promise。新增一个要在这里登记（并写它的那句话）
    expect(inspecting.sort()).toEqual([
      'apps/desktop/src/main/tools/shuvix.ts',
      'packages/agent-runtime/src/askTool.ts',
      'packages/agent-runtime/src/security/enforce.ts'
    ])
  })

  it('UG-2b the choke point itself: DurableSession.requestUserInput checks the flag before the pending table', () => {
    const source = readFileSync(
      join(REPO, 'packages/agent-runtime/src/durable/durableSession.ts'),
      'utf8'
    )
    const body = source.slice(source.indexOf('  requestUserInput(request: InputRequest)'))
    const refuse = body.indexOf("reason: 'unattended'")
    const enqueue = body.indexOf('this.inputs.request(request)')
    expect(refuse).toBeGreaterThan(0)
    expect(enqueue).toBeGreaterThan(refuse)
    // 产品代码里进挂起表的只有这一处
    const callers = productFiles(join(REPO, 'packages/agent-runtime/src')).filter((file) =>
      /\binputs\.request\(/.test(readFileSync(file, 'utf8'))
    )
    expect(callers.map((file) => relative(REPO, file).split('\\').join('/'))).toEqual([
      'packages/agent-runtime/src/durable/durableSession.ts'
    ])
  })

  it('UG-2c sanity: the text helpers used above are the ones the askers produce', () => {
    expect(isUnattendedResult(unattendedApprovalText('Write(/ws/x)'))).toBe(true)
    expect(isUnattendedResult(UNATTENDED_QUESTION_TEXT)).toBe(true)
  })
})
