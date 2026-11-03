/**
 * 中止的范围（根 CLAUDE.md「Tool execution flow」）：停一个子对话只取消这棵子树发起的询问和审查，根对话与兄弟 agent
 * 正在等的卡片不受影响；被停的工具不留下一张过后答了还会照样执行的卡片。全程真工具、真安全模块、真路由。
 *
 *  - SCOPE-I1 面板软停止 / 销毁：C 的 ask、孙子 G 的写卡、没写明对话的卡片都取消；兄弟 S 与根的写卡留着，答了就写
 *  - SCOPE-I2 宿主派发（`owner:{anchor}` + 外部 signal）的写卡：signal 落下卡片就没了、runTask 交回 aborted（修之前这里挂住）
 *  - SCOPE-I5 根和 C 各有一次审查在跑：停 C 只中止 C 的审查，根的审查跑完，判定照样生效
 *  - SCOPE-I5b 真写工具把这次调用的 signal 交给安全模块：审查不收尾，signal 一落工具也不再等它
 */
import type { FauxResponseStep } from '@earendil-works/pi-ai'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { describe, expect, it } from 'vitest'
import { clearReviewState } from '../../../security/reviewState'
import { toInProcessAgentType } from '../../../subagent/dispatchTool'
import { executeTool } from '../../../tools/testing/invokeTool'
import { answer, callTool, held, stalled } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { messageText } from '../support/transcript'
import { deferred, waitFor, withTimeout } from '../support/wait'
import { memFs } from './support/memFs'
import { fileSuite, securityFor } from './support/realTools'
import { callTools } from './support/scriptedModel'
import {
  childOfCall,
  fate,
  ownedBy,
  registerSpawnCleanup,
  resultOf,
  spawnWorld,
  tasksIn,
  toolTaskOf,
  V_ALLOW,
  type SpawnWorld
} from './support/spawnWorld'
import { allow, choose, nextInput, registerWorldCleanup, resolvedCount } from './support/world'

registerHostCleanup()
registerWorldCleanup()
registerSpawnCleanup()

const TIMEOUT = 15000
const ABORTED: InputResponse = { kind: 'cancel', reason: 'aborted' }
const ALLOWED: InputResponse = { kind: 'ask', allowed: true }

const ASK_ARGS = {
  question: 'Which one?',
  options: [
    { label: 'A', description: 'first' },
    { label: 'B', description: 'second' }
  ]
}

/** C：既问人又派孙子（车道沿用 nester）；S：只写（自己一条车道） */
const MIDDLE_MD = `---
shuvix: agent v1
name: nester
description: Asks and delegates
shuvix-displayName: Middle
shuvix-tools: read, ask, agent, mcp:ctx
---

You ask and delegate. [lane:nester]
`

const SIBLING_MD = `---
shuvix: agent v1
name: sibling
description: Writes a file
shuvix-displayName: Sibling
shuvix-tools: write
---

You write. [lane:sibling]
`

function stopWorld(): Promise<SpawnWorld> {
  return spawnWorld({
    profiles: { nester: MIDDLE_MD, sibling: SIBLING_MD },
    lanes: (model) =>
      model.lane('sibling', ({ systemPrompt }) => systemPrompt.includes('[lane:sibling]'))
  })
}

const pendingIds = (sw: SpawnWorld): string[] =>
  sw.world
    .session()
    .pendingInputs()
    .map((request) => request.id)
    .sort()

describe('stopping one conversation cancels only its subtree', () => {
  it.each(['interrupt', 'destroy'] as const)(
    'SCOPE-I1(%s) C, G and the unnamed card are cancelled and G writes nothing; S and root stay pending and finish when answered',
    async (stop) => {
      const sw = await stopWorld()
      const { world } = sw
      const session = await sw.open()
      world.chat(
        callTools(
          ['agent', { name: 'nester', prompt: 'mid', description: 'c' }, 'r-c'],
          ['agent', { name: 'sibling', prompt: 'sib', description: 's' }, 'r-s'],
          ['write', { path: 'root.txt', content: 'R' }, 'r-w'],
          ['ask', ASK_ARGS, 'r-ask']
        ),
        answer('root done')
      )
      world.model.chatIn(
        'nester',
        callTools(
          ['ask', ASK_ARGS, 'c-ask'],
          ['agent', { name: 'explore', prompt: 'leaf', description: 'g' }, 'c-g']
        )
      )
      world.model.chatIn('explore', callTool('write', { path: 'g.txt', content: 'G' }, 'g-w'))
      world.model.chatIn(
        'sibling',
        callTool('write', { path: 's.txt', content: 'S' }, 's-w'),
        answer('s done')
      )

      const sending = session.submitUser('go')
      await nextInput(world, 'c-ask')
      await nextInput(world, 'g-w')
      await nextInput(world, 's-w')
      await nextInput(world, 'r-w')
      await nextInput(world, 'r-ask')
      const unnamed = session.requestUserInput({
        id: 'unnamed',
        kind: 'ask',
        toolName: 'test',
        command: 'no conversation named',
        createdAt: 0
      })
      const C = await childOfCall(session, 'r-c')
      const S = await childOfCall(session, 'r-s')
      const G = await childOfCall(session, 'c-g', C)
      expect(pendingIds(sw)).toEqual(['c-ask', 'g-w', 'r-ask', 'r-w', 's-w', 'unnamed'])

      await withTimeout(session.agents[stop](C), 3000, stop)

      expect(await unnamed).toStrictEqual(ABORTED)
      expect(pendingIds(sw)).toEqual(['r-ask', 'r-w', 's-w'])
      for (const id of ['c-ask', 'g-w', 'unnamed']) {
        expect(resolvedCount(world, id), id).toBe(1)
        expect(session.respondToInput(id, ALLOWED), id).toBe(false)
      }
      expect(world.fs.writesTo('/ws/g.txt')).toBe(0)
      for (const conversation of [C, G]) {
        expect((await tasksIn(session, conversation, 'pi.generation')).map(fate)).toEqual([
          'aborted'
        ])
      }
      expect(world.fs.writesTo('/ws/s.txt')).toBe(0)
      expect(world.fs.writesTo('/ws/root.txt')).toBe(0)

      allow(world, 's-w')
      allow(world, 'r-w')
      choose(world, 'r-ask', ['A'])
      expect(await withTimeout(sending, 5000, 'root send')).toEqual({})

      expect((await resultOf(session, 1, 'r-ask')).text).toBe('User selected: A')
      expect(world.fs.writesTo('/ws/s.txt')).toBe(1)
      expect(world.fs.writesTo('/ws/root.txt')).toBe(1)
      expect(world.fs.writesTo('/ws/g.txt')).toBe(0)
      for (const [conversation, callId] of [
        [S, 's-w'],
        [1, 'r-w']
      ] as const) {
        const result = await resultOf(session, conversation, callId)
        expect(result.isError, callId).toBe(false)
        expect(result.text, callId).not.toContain('borted')
      }
      expect((await resultOf(session, 1, 'r-s')).text).toBe('s done')
    },
    TIMEOUT
  )

  it(
    "SCOPE-I2 a hook agent's write card goes when its dispatch signal falls: runTask settles aborted, no file, the root card stays",
    async () => {
      const sw = await stopWorld()
      const { world } = sw
      const session = await sw.open()
      world.chat(callTool('write', { path: 'root.txt', content: 'R' }, 'r-w'), answer('root done'))
      world.model.chatIn('explore', callTool('write', { path: 'h.txt', content: 'H' }, 'h-w'))
      const sending = session.submitUser('go')
      await nextInput(world, 'r-w')

      const controller = new AbortController()
      const dispatched = sw.router.router.runTask({
        sessionId: 's1',
        owner: { anchor: true },
        agentType: toInProcessAgentType(sw.profiles.get('explore')!),
        prompt: 'write it',
        description: 'hook write',
        signal: controller.signal
      })
      await nextInput(world, 'h-w')
      expect(pendingIds(sw)).toEqual(['h-w', 'r-w'])

      controller.abort()
      const outcome = await withTimeout(dispatched, 2000, 'runTask')

      expect(outcome.error).toBe('aborted')
      expect(pendingIds(sw)).toEqual(['r-w'])
      expect(session.respondToInput('h-w', ALLOWED)).toBe(false)
      expect(world.fs.writesTo('/ws/h.txt')).toBe(0)
      expect(world.fs.files.has('/ws/h.txt')).toBe(false)

      allow(world, 'r-w')
      expect(await withTimeout(sending, 5000, 'root send')).toEqual({})
      expect(world.fs.writesTo('/ws/root.txt')).toBe(1)
      expect(world.fs.writesTo('/ws/h.txt')).toBe(0)
    },
    TIMEOUT
  )

  it.each([
    { verdict: 'allow', opinion: V_ALLOW },
    {
      verdict: 'ask',
      opinion: { decision: 'ask', risk: 'medium', summary: 'ROOT-SUMMARY', reason: 'WHY' }
    }
  ])(
    "SCOPE-I5($verdict) with two reviews running, stopping C aborts only C's: no card and no write for C; root's verdict still applies",
    async ({ verdict, opinion }) => {
      const sw = await stopWorld()
      sw.review.enabled = true
      const { world } = sw
      const session = await sw.open()
      world.chat(
        callTools(
          ['agent', { name: 'explore', prompt: 'write', description: 'c' }, 'r-c'],
          ['write', { path: 'root.txt', content: 'R' }, 'r-w']
        ),
        answer('root done')
      )
      world.model.chatIn('explore', callTool('write', { path: 'c.txt', content: 'C' }, 'c-w'))
      const rootReview = held(callTool('next', opinion, 'v-root'))
      const childReview = stalled()
      // 两次审查同一条车道、到达次序不定：按审查的操作分
      const byTarget: FauxResponseStep = (context, options, state, model) => {
        const text = context.messages.map((message) => messageText(message)).join('\n')
        const step = text.includes('root.txt') ? rootReview.step : childReview.step
        return typeof step === 'function' ? step(context, options, state, model) : step
      }
      world.model.chatIn('reviewer', byTarget, byTarget)

      const sending = session.submitUser('go')
      await withTimeout(rootReview.reached, 3000, 'root review')
      await withTimeout(childReview.reached, 3000, 'child review')
      const C = await childOfCall(session, 'r-c')
      const childWrite = await toolTaskOf(session, C, 'c-w')
      const rootWrite = await toolTaskOf(session, 1, 'r-w')
      const [childReviewer] = await ownedBy(session, childWrite.id)
      const [rootReviewer] = await ownedBy(session, rootWrite.id)
      expect(childReviewer).toBeDefined()
      expect(rootReviewer).toBeDefined()

      await withTimeout(session.agents.interrupt(C), 3000, 'interrupt')

      expect((await tasksIn(session, childReviewer!, 'pi.generation')).map(fate)).toEqual([
        'aborted'
      ])
      await waitFor(() => sw.ends('auto-review').length === 1, 2000, 'child review end')
      expect(sw.ends('auto-review')[0]).toMatchObject({ ok: false, error: 'aborted' })
      expect(world.t.asksOf('input_request').map((event) => event.request.id)).toEqual([])
      expect(world.fs.writesTo('/ws/c.txt')).toBe(0)
      // 根的审查还在跑：没被中止，也还没结论
      for (const task of await tasksIn(session, rootReviewer!)) {
        expect(task.abortRequested).toBe(false)
      }
      expect(fate((await tasksIn(session, rootReviewer!, 'pi.generation'))[0]! as never)).not.toBe(
        'aborted'
      )
      expect(world.fs.writesTo('/ws/root.txt')).toBe(0)

      rootReview.release()
      if (verdict === 'ask') {
        const shown = await nextInput(world, 'r-w')
        expect(shown).toMatchObject({
          kind: 'ask',
          conversationId: 1,
          review: { risk: 'medium', summary: 'ROOT-SUMMARY', reason: 'WHY' }
        })
        expect(world.fs.writesTo('/ws/root.txt')).toBe(0)
        allow(world, 'r-w')
      }
      expect(await withTimeout(sending, 5000, 'root send')).toEqual({})

      expect(world.fs.writesTo('/ws/root.txt')).toBe(1)
      expect(world.fs.writesTo('/ws/c.txt')).toBe(0)
      expect((await resultOf(session, 1, 'r-w')).isError).toBe(false)
      expect(world.t.asksOf('input_request').map((event) => event.request.id)).toEqual(
        verdict === 'ask' ? ['r-w'] : []
      )
    },
    TIMEOUT
  )

  it('SCOPE-I5b a real write hands its call signal to the security module: once it falls the tool stops waiting for a review that never answers, with no card and no write', async () => {
    const SESSION = 'direct-stop-scope'
    const fs = memFs({})
    const reviewing = deferred<AbortSignal | undefined>()
    const cards: InputRequest[] = []
    const suite = fileSuite(
      fs,
      securityFor(
        SESSION,
        async (request) => {
          cards.push(request)
          return ALLOWED
        },
        [],
        // 审查永不落定，也不看 signal
        (_event, signal) => {
          reviewing.resolve(signal)
          return new Promise(() => undefined)
        }
      )
    )
    const controller = new AbortController()
    const running = executeTool(
      suite.write,
      'c-w',
      { path: 'x.txt', content: 'X' },
      controller.signal
    )
    const seamSignal = await withTimeout(reviewing.promise, 3000, 'the review started')
    expect(seamSignal?.aborted).toBe(false)

    controller.abort()
    await expect(withTimeout(running, 2000, 'the write settled')).rejects.toThrow('Aborted')

    expect(seamSignal?.aborted).toBe(true)
    expect(cards).toEqual([])
    expect(fs.writes).toEqual([])
    clearReviewState(SESSION)
  })
})
