/**
 * 会话 fork · 往返（SQLite）：源会话 s1 的 `whileIdle` 里 `VACUUM INTO` 拷成 s2 的文件（与宿主
 * `copyDurableStorage` 同一做法）→ 按路径开那份拷贝 `resetForkedSessionState` → 宿主打开 s2。
 *
 *   RT-1 三轮、已锁：拷贝期间 s1 什么都没发布；s2 的视图与 id 和 s1 一样、没有锁、没建 agent；s2.branchAt(A1)
 *        → s2 [U1, A1]，s1 仍是六条；两边各自发送，请求各带各的历史
 *   RT-2 s1 是被驱动的子会话（标记留着，seam 失败）：收尾过的 s2 打开时 seam 从不为 s2 调用（对照：没收尾的
 *        拷贝 s3 打开时会替 s3 报一次）
 *   RT-3 s1 有一条待送达通知：s2 的第一次发送不落通知；s1 的照样落
 *   RT-4 s1 回退过：整段 fork 显示的是回退后的分支，接着发送也在那上面
 *   RT-5 s2 第一次发送（建锁）之后，当前对话 AgentStateDoc 的 rootSessionId 是 's2'（拷来的是 's1'）
 *
 * fork 沿用源会话的 agent（2026-11-06：收尾留下锁 + `adoptForkedAgent`）：
 *   RT-D4 认领之后第一次打开：按拷来的锁重建（与 LRU 关了再开同一条路：不读配置、不连 MCP、不写 pi.agent）；
 *         不认领的同一份拷贝打开时清锁
 *   RT-D5 源会话跑过几轮（中途重配把工具次序弄成非 K6 的，轮与轮之间日期变了）→ 整段 fork：fork 的第一次请求
 *         与源会话的下一次请求系统提示词逐字节相同、工具同名同序同声明、模型相同；pi.provider 原样拷来
 *   RT-D7 从回复分支（branchAt 更早的那张卡）：锁销毁、在分支上重建 —— 人设沿用（日期变了也不重新渲染块），
 *         工具按模型在分支点之前见过的次序，系统提示词等于源会话在那一刻的
 *   RT-D8 认领标记丢了（第一次打开之前换了进程）：打开时清锁、发送时重建，人设沿用、工具按见过的次序，
 *         请求与源会话的下一次相同
 *   RT-D9 认领的整段 fork：段落是源会话冻结的那份（2026-11-06）—— fork 的请求带着它，一个 seam 都不调
 *   RT-D9b 同上，但 fork 的文档没有冻结的段落（旧对话）：活段落（指令文件 / 项目提示词 / 知识库 / bot）按 fork
 *          自己的会话 id 解析
 *   RT-D9c 不认领的整段 fork（锁清掉）：重新上锁沿用冻结的段落、根会话 id 改成 fork 自己的；比对按 fork 的会话
 *          解析，来源对 fork 而言不同 → 提醒，请求照旧
 *   RT-D9d 从回复分支（branchAt）：在分支上重新上锁，系统提示词等于源会话在那一刻的（冻结的段落），seam 只为比对
 *          各调一次
 */
import { AgentDoc, ProviderDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, SessionStateDoc } from '../docs'
import type { DrivenSettledEvent, DurableSession } from '../durableSession'
import type { PromptHost } from '../seams'
import { E_W, scenarioConfig } from './support/agentConfig'
import { answer } from './support/faux'
import { copyStorageFile, forkStorage } from './support/fork'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import {
  contents,
  forkedId,
  messageIds,
  noticeTexts,
  rawPublications,
  rollbackBase,
  threeTurns,
  viewOf
} from './support/rollback'
import { scenarioW } from './support/scenario'
import { allEntries, requestTexts } from './support/transcript'
import { sleep, waitFor } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000

const SIX = ['U1', 'A1', 'U2', 'A2', 'U3', 'A3']

/** 同一批消息换成另一条会话的（消息带着它所属会话的 id，其余逐字相同） */
function inSession(messages: readonly ChatMessage[], sessionId: string): ChatMessage[] {
  return messages.map((message) => ({ ...message, sessionId }))
}

/** fork 成功（拷了、收了尾） */
async function fork(t: TestHost, source: DurableSession, toId: string): Promise<void> {
  expect(await forkStorage(t, source, toId)).toEqual({ ok: true, value: undefined })
}

describe('session fork · copy, reset, open', () => {
  it(
    'RT-1 a three-turn locked session: nothing published during the copy; s2 has the same view and ids, no lock, no agent; s2.branchAt(A1) leaves s1 alone; sends go to their own histories',
    async () => {
      const { t, session: s1, ids } = await rollbackBase()
      const lock = s1.lock
      expect(lock).toBeDefined()
      const before = await viewOf(s1)
      const recorder = rawPublications(s1)
      await fork(t, s1, 's2')
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(s1.lock).toBe(lock)

      const configCalls = t.configCalls.length
      const s2 = await t.open('s2')
      const view = await viewOf(s2)
      expect(view.sessionId).toBe('s2')
      expect(view.conversationId).toBe(before.conversationId)
      expect(view.messages).toStrictEqual(inSession(before.messages, 's2'))
      expect(messageIds(view)).toEqual([ids.u1, ids.a1, ids.u2, ids.a2, ids.u3, ids.a3].map(String))
      expect(view.run.state).toBe('idle')
      expect(s2.lock).toBeUndefined()
      expect((await s2.harness.snapshot(SessionStateDoc, BG))?.lock).toBeUndefined()
      expect(t.configCalls.slice(configCalls)).not.toContain('s2')
      expect(t.mirror).not.toContainEqual(['s2', true])
      expect(s2.isInterrupted()).toBe(false)
      // s1 原样
      expect(await viewOf(s1)).toStrictEqual(before)

      const branched = await s2.branchAt(ids.a1)
      expect(branched).toEqual({ ok: true, conversationId: expect.any(Number) })
      expect(contents(await viewOf(s2))).toEqual(['U1', 'A1'])
      expect(contents(await viewOf(s1))).toEqual(SIX)
      expect((await s1.currentConversation()).id).toBe(before.conversationId)

      const n = t.kit.requests.length
      t.kit.queue(answer('B4'))
      expect(await s2.submitUser('U4')).toEqual({})
      expect(requestTexts(t.kit, n)).toEqual(['user:U1', 'assistant:A1', 'user:U4'])
      t.kit.queue(answer('C4'))
      expect(await s1.submitUser('V4')).toEqual({})
      expect(requestTexts(t.kit, n + 1)).toEqual([
        'user:U1',
        'assistant:A1',
        'user:U2',
        'assistant:A2',
        'user:U3',
        'assistant:A3',
        'user:V4'
      ])
      expect(contents(await viewOf(s2))).toEqual(['U1', 'A1', 'U4', 'B4'])
      expect(contents(await viewOf(s1))).toEqual([...SIX, 'V4', 'C4'])
    },
    TIMEOUT
  )

  it(
    'RT-2 a driven sub-session (marker kept, the seam failed): opening the reset fork never calls the seam for s2; an unreset copy would report for its own id',
    async () => {
      const seam = vi.fn(async (event: DrivenSettledEvent) => {
        if (event.sessionId === 's1') throw new Error('parent offline')
      })
      const t = await makeHost({ onDrivenSettled: seam })
      const s1 = await t.open('s1')
      await primeRoot(s1)
      t.kit.queue(answer('done'))
      expect(
        await s1.submitUser('task', { requestId: 'R', driven: { parentId: 'P', background: true } })
      ).toEqual({})
      await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called for s1')
      expect((await s1.harness.snapshot(SessionStateDoc, BG))?.driven).toBeDefined()

      await fork(t, s1, 's2')
      const s2 = await t.open('s2')
      await sleep(80)
      expect(seam.mock.calls.filter(([event]) => event.sessionId === 's2')).toEqual([])
      expect((await s2.harness.snapshot(SessionStateDoc, BG))?.driven).toBeUndefined()
      // s2 自己的一轮也不报（它没被驱动）
      t.kit.queue(answer('own'))
      expect(await s2.submitUser('own turn')).toEqual({})
      await sleep(30)
      expect(seam.mock.calls.filter(([event]) => event.sessionId === 's2')).toEqual([])

      // 对照：不收尾的整拷，打开时的扫描会替拷贝向父会话报一次
      expect(await s1.whileIdle(async () => copyStorageFile(t.file('s1'), t.file('s3')))).toEqual({
        ok: true,
        value: undefined
      })
      await t.open('s3')
      await waitFor(
        () => seam.mock.calls.some(([event]) => event.sessionId === 's3'),
        3000,
        'seam called for the unreset copy'
      )
    },
    TIMEOUT
  )

  it(
    'RT-3 a deferred notice on s1: the first send on s2 lands no notice; s1’s next send still does',
    async () => {
      const { t, session: s1 } = await rollbackBase()
      await s1.harness.commit(async (tx) => {
        const state = await tx.doc(SessionStateDoc)
        state.deferredNotices.push({ requestId: 'n1', text: 'N1', kind: 'background' })
      }, BG)
      await fork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect((await s2.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])

      t.kit.queue(answer('B4'))
      expect(await s2.submitUser('U4')).toEqual({})
      expect(noticeTexts(await allEntries(await s2.currentConversation()))).toEqual([])

      t.kit.queue(answer('C4'))
      expect(await s1.submitUser('V4')).toEqual({})
      const s1Entries = await allEntries(await s1.currentConversation())
      expect(noticeTexts(s1Entries)).toEqual(['N1'])
      expect((await s1.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])
      // 通知恰好排在这次发送之前
      const kinds = s1Entries.filter((entry) => entry.kind !== 'pi.system').map((e) => e.kind)
      expect(kinds.slice(-3)).toEqual(['shuvix.notice', 'pi.user', 'pi.assistant'])
    },
    TIMEOUT
  )

  it(
    'RT-4 after a rollback on s1, a whole fork shows the rolled-back branch and continues on it',
    async () => {
      const { t, session: s1, ids } = await rollbackBase()
      const F = forkedId(await s1.rollbackTo(ids.u2))
      const before = await viewOf(s1)
      expect(contents(before)).toEqual(['U1', 'A1'])

      await fork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect((await s2.currentConversation()).id).toBe(F)
      const view = await viewOf(s2)
      expect(view.conversationId).toBe(F)
      expect(view.messages).toStrictEqual(inSession(before.messages, 's2'))

      const n = t.kit.requests.length
      t.kit.queue(answer('B4'))
      expect(await s2.submitUser('U4')).toEqual({})
      expect(requestTexts(t.kit, n)).toEqual(['user:U1', 'assistant:A1', 'user:U4'])
      expect(s2.lock?.conversationId).toBe(F)
    },
    TIMEOUT
  )

  it(
    "RT-5 after the first send on s2 the current conversation's AgentStateDoc.rootSessionId is 's2' (the copy carried 's1')",
    async () => {
      const t = await makeHost()
      const s1 = await t.open('s1')
      await primeRoot(s1)
      await threeTurns(s1, t)
      const conversation = (await s1.currentConversation()).id
      expect((await s1.harness.snapshot(AgentStateDoc, conversation, BG))?.rootSessionId).toBe('s1')

      await fork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect((await s2.harness.snapshot(AgentStateDoc, conversation, BG))?.rootSessionId).toBe('s1')
      t.kit.queue(answer('B4'))
      expect(await s2.submitUser('U4')).toEqual({})
      const current = (await s2.currentConversation()).id
      expect((await s2.harness.snapshot(AgentStateDoc, current, BG))?.rootSessionId).toBe('s2')
      expect((await s1.harness.snapshot(AgentStateDoc, conversation, BG))?.rootSessionId).toBe('s1')
    },
    TIMEOUT
  )

  it(
    'RT-D4 an adopted fork is rebuilt from the copied lock on first open (no config read, no MCP connect, no pi.agent write); the same copy without adopt clears the lock on open',
    async () => {
      const { t } = await scenarioW()
      const s1 = await t.open('s1')
      t.kit.queue(answer('one'))
      expect(await s1.submitUser('u1')).toEqual({})
      const lock = s1.lock!

      await adoptedFork(t, s1, 's2')
      const configCalls = t.configCalls.length
      const connects = t.toolHost.mcp('ctx').connects
      const rebuilds = t.toolHost.rebuildCalls.length
      const s2 = await t.open('s2')
      expect(s2.lock).toEqual(lock)
      expect(t.toolHost.rebuildCalls.slice(rebuilds)).toEqual([lock])
      expect(t.toolHost.rebuildContexts.at(-1)!.connect).toBeUndefined()
      expect(t.configCalls.slice(configCalls)).toEqual([])
      expect(t.toolHost.mcp('ctx').connects).toBe(connects)
      expect(t.toolHost.resolveCalls).toHaveLength(1)
      expect(await s2.harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, BG)).toEqual(
        await s1.harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, BG)
      )
      expect(t.mirror).toContainEqual(['s2', true])

      // 对照：同样留了锁、但没认领 → 打开时清锁（这个进程没初始化过它）
      expect(await forkStorage(t, s1, 's3', { keepLock: true, adopt: false })).toEqual({
        ok: true,
        value: undefined
      })
      const s3 = await t.open('s3')
      expect(s3.lock).toBeUndefined()
      expect((await s3.harness.snapshot(SessionStateDoc, BG))?.lock).toBeUndefined()
      expect(t.mirror).toContainEqual(['s3', false])
    },
    TIMEOUT
  )

  it(
    "RT-D5 several turns with a reconfigure-reordered tool set and a changing date: the adopted whole fork's first request equals the source's next request (system prompt bytes, tools, model); pi.provider is copied unchanged",
    async () => {
      const { t, vars } = await sourceWithHistory()
      const s1 = await t.open('s1')
      const calls = vars.state.calls
      const providerBefore = await s1.harness.snapshot(ProviderDoc, ROOT_CONVERSATION_ID, BG)

      await adoptedFork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect(await s2.harness.snapshot(ProviderDoc, ROOT_CONVERSATION_ID, BG)).toEqual(
        providerBefore
      )
      vars.state.date = '2026-11-09'
      t.kit.queue(answer('fork-answer'))
      expect(await s2.submitUser('U4')).toEqual({})
      const fromFork = t.kit.requests.at(-1)!
      t.kit.queue(answer('source-answer'))
      expect(await s1.submitUser('V4')).toEqual({})
      const fromSource = t.kit.requests.at(-1)!

      expect(fromFork.systemPrompt).toBe(fromSource.systemPrompt)
      expect(fromFork.tools).toEqual(fromSource.tools)
      expect(fromFork.tools.map((tool) => tool.name)).toEqual([...E_W, 'mcp__new__fresh'])
      expect(fromFork.modelId).toBe(fromSource.modelId)
      expect(vars.state.calls).toBe(calls)
      expect(s2.lock).toEqual(s1.lock)
    },
    TIMEOUT
  )

  it(
    'RT-D7 a reply fork (branchAt an earlier card): the lock is destroyed and recreated on the branch; the persona is reused although the date changed; the tools follow what the model saw up to the branch point; the system prompt equals the source’s at that point',
    async () => {
      const { t, vars, ids } = await sourceWithHistory()
      const s1 = await t.open('s1')
      const calls = vars.state.calls
      const atBranch = t.kit.requests[0]!

      await adoptedFork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect(s2.lock).toBeDefined()
      const created = t.broadcastsOf('agent_created').length
      expect(await s2.branchAt(ids.a1)).toEqual({ ok: true, conversationId: expect.any(Number) })
      expect(s2.lock).toBeUndefined()

      vars.state.date = '2026-11-09'
      t.kit.queue(answer('B2'))
      expect(await s2.submitUser('U2 on the branch')).toEqual({})
      const request = t.kit.requests.at(-1)!
      expect(t.broadcastsOf('agent_created').length).toBe(created + 1)
      expect(vars.state.calls).toBe(calls)
      expect(request.systemPrompt).toBe(atBranch.systemPrompt)
      // 分支点之前模型见过的是 E_W（重配在那之后）：原样打头，此刻勾选里新加的追加在后
      expect(request.tools.slice(0, E_W.length)).toEqual(atBranch.tools)
      expect(request.tools.map((tool) => tool.name)).toEqual([...E_W, 'mcp__new__fresh'])
      expect(s2.lock!.toolNames).toEqual([...E_W, 'mcp__new__fresh'])
    },
    TIMEOUT
  )

  it(
    'RT-D8 the adopt mark is lost (a new process before the first open): the lock is cleared on open and recreated on send; persona reused, tools in the seen order, the request equals the source’s next one',
    async () => {
      const { t, vars } = await sourceWithHistory()
      const s1 = await t.open('s1')
      const calls = vars.state.calls
      await adoptedFork(t, s1, 's2')
      t.kit.queue(answer('source-answer'))
      expect(await s1.submitUser('V4')).toEqual({})
      const fromSource = t.kit.requests.at(-1)!

      vars.state.date = '2026-11-09'
      const t2 = await t.restart()
      const s2 = await t2.open('s2')
      expect(s2.lock).toBeUndefined()
      t2.kit.queue(answer('fork-answer'))
      expect(await s2.submitUser('U4')).toEqual({})
      const fromFork = t2.kit.requests.at(-1)!
      expect(t2.configCalls).toEqual(['s2'])
      expect(vars.state.calls).toBe(calls)
      expect(fromFork.systemPrompt).toBe(fromSource.systemPrompt)
      expect(fromFork.tools).toEqual(fromSource.tools)
      expect(fromFork.modelId).toBe(fromSource.modelId)
      expect(
        (await s2.harness.snapshot(AgentStateDoc, (await s2.currentConversation()).id, BG))
          ?.rootSessionId
      ).toBe('s2')
    },
    TIMEOUT
  )

  it(
    'RT-D9 an adopted whole fork carries the sections the source froze: the request is the source text, no seam is called',
    async () => {
      const { t, calls } = await botSourceScenario()
      const s1 = await t.open('s1')
      t.kit.queue(answer('one'))
      expect(await s1.submitUser('u1')).toEqual({})
      const sourcePrompt = t.kit.requests[0]!.systemPrompt
      for (const text of ['instructions of s1', 'project of s1', 'knowledge of s1', 'bot of s1']) {
        expect(sourcePrompt).toContain(text)
      }

      await adoptedFork(t, s1, 's2')
      const s2 = await t.open('s2')
      for (const name of Object.keys(calls)) calls[name] = []
      t.kit.queue(answer('two'))
      expect(await s2.submitUser('u2')).toEqual({})
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(sourcePrompt)
      expect(Object.values(calls).flat()).toEqual([])
      // 根会话 id 改成了 fork 自己的（收尾时），冻结的段落原样
      const state = await s2.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)
      expect(state?.rootSessionId).toBe('s2')
      expect(state?.sections).toEqual(
        (await s1.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG))?.sections
      )
    },
    TIMEOUT
  )

  it(
    "RT-D9b an adopted whole fork whose document has no frozen sections (an old conversation) resolves the live sections (instructions, project prompt, knowledge bases, bot) against the fork's own session id",
    async () => {
      const { t, calls } = await botSourceScenario()
      const s1 = await t.open('s1')
      t.kit.queue(answer('one'))
      expect(await s1.submitUser('u1')).toEqual({})
      // 改成 2026-11-06 之前的样子：只冻结了人设
      await s1.harness.commit(async (tx) => {
        const state = await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)
        delete state.sections
        delete state.personaKey
      }, BG)

      await adoptedFork(t, s1, 's2')
      const s2 = await t.open('s2')
      for (const name of Object.keys(calls)) calls[name] = []
      t.kit.queue(answer('two'))
      expect(await s2.submitUser('u2')).toEqual({})
      expect(Object.keys(calls).sort()).toEqual([
        'resolveBotContext',
        'resolveInstruction',
        'resolveKnowledgeBases',
        'resolveProjectPrompt'
      ])
      for (const [name, ids] of Object.entries(calls)) {
        expect(ids.length, name).toBeGreaterThan(0)
        expect(new Set(ids), name).toEqual(new Set(['s2']))
      }
      const prompt = t.kit.requests.at(-1)!.systemPrompt
      for (const text of ['instructions of s2', 'project of s2', 'knowledge of s2', 'bot of s2']) {
        expect(prompt).toContain(text)
      }
      expect(prompt).not.toContain('of s1')
    },
    TIMEOUT
  )

  it(
    "RT-D9c a whole fork that is not adopted (the lock is cleared): the re-lock reuses the frozen sections with the fork's own root session id; comparing resolves against the fork, so every section is reported while the request stays the source text",
    async () => {
      const { t, calls } = await botSourceScenario()
      const s1 = await t.open('s1')
      t.kit.queue(answer('one'))
      expect(await s1.submitUser('u1')).toEqual({})
      const sourcePrompt = t.kit.requests[0]!.systemPrompt
      const sourceSections = (await s1.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG))
        ?.sections

      await fork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect(s2.lock).toBeUndefined()
      for (const name of Object.keys(calls)) calls[name] = []
      t.kit.queue(answer('two'))
      expect(await s2.submitUser('u2')).toEqual({})
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(sourcePrompt)
      const state = await s2.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)
      expect(state?.rootSessionId).toBe('s2')
      expect(state?.sections).toEqual(sourceSections)
      // 只为比对调了一次（按 fork 自己的会话）
      for (const [name, ids] of Object.entries(calls)) expect(ids, name).toEqual(['s2'])
      expect(await s2.systemPromptStatus()).toEqual({
        frozen: true,
        stale: [
          { key: 'agents_md', file: 'AGENTS.md' },
          { key: 'project_prompt' },
          { key: 'knowledge_bases' },
          { key: 'bot_profile' }
        ]
      })
    },
    TIMEOUT
  )

  it(
    'RT-D9d a reply fork (branchAt): the re-lock on the branch carries the frozen sections, so the system prompt equals the source’s at that point; each seam is asked once, to compare',
    async () => {
      const { t, calls } = await botSourceScenario()
      const s1 = await t.open('s1')
      t.kit.queue(answer('one'), answer('two'))
      expect(await s1.submitUser('u1')).toEqual({})
      expect(await s1.submitUser('u2')).toEqual({})
      const atBranch = t.kit.requests[0]!.systemPrompt
      const a1 = (await allEntries(await s1.currentConversation())).find(
        (entry) => entry.kind === 'pi.assistant'
      )!.id as number

      await adoptedFork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect(await s2.branchAt(a1)).toEqual({ ok: true, conversationId: expect.any(Number) })
      expect(s2.lock).toBeUndefined()
      for (const name of Object.keys(calls)) calls[name] = []
      t.kit.queue(answer('B2'))
      expect(await s2.submitUser('U2 on the branch')).toEqual({})
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(atBranch)
      for (const [name, ids] of Object.entries(calls)) expect(ids, name).toEqual(['s2'])
    },
    TIMEOUT
  )
})

/** 场景 W 换成 bot 档案（四个活段落都选）；每段的文本写着解析时的会话 id，调用按 seam 记下会话 id */
async function botSourceScenario(): Promise<{ t: TestHost; calls: Record<string, string[]> }> {
  const calls: Record<string, string[]> = {}
  const note = (name: string, sessionId: string): void => {
    ;(calls[name] ??= []).push(sessionId)
  }
  const promptHost: PromptHost = {
    resolveInstruction: (sessionId) => {
      note('resolveInstruction', sessionId)
      return { filename: 'AGENTS.md', content: `instructions of ${sessionId}` }
    },
    resolveProjectPrompt: (sessionId) => {
      note('resolveProjectPrompt', sessionId)
      return `project of ${sessionId}`
    },
    resolveKnowledgeBases: (sessionId) => {
      note('resolveKnowledgeBases', sessionId)
      return `knowledge of ${sessionId}`
    },
    resolveBotContext: (sessionId) => {
      note('resolveBotContext', sessionId)
      return `bot of ${sessionId}`
    }
  }
  const config = scenarioConfig()
  // bot 档案上的根 agent 四段都选
  config.profile = { ...config.profile, name: 'bot' }
  const { t } = await scenarioW({ config, promptHost })
  return { t, calls }
}

/** 留下锁 + 认领的整段 fork（宿主今天的做法） */
async function adoptedFork(t: TestHost, source: DurableSession, toId: string): Promise<void> {
  expect(await forkStorage(t, source, toId, { keepLock: true })).toEqual({
    ok: true,
    value: undefined
  })
}

/**
 * s1（场景 W，`environment` 块带日期）：U1 A1 → 日期变了、中途勾上 new（勾选里排在 ctx 前，重配把它追加在最后）→ U2 A2
 * → 日期又变了 → U3 A3。交回宿主、块的状态与 U1 / A1 的 id。
 */
async function sourceWithHistory(): Promise<{
  t: TestHost
  vars: { state: { date: string; calls: number } }
  ids: { u1: number; a1: number }
}> {
  const config = scenarioConfig()
  const state = { date: '2026-11-05', calls: 0 }
  const { t } = await scenarioW({
    config,
    promptBlocks: () => {
      state.calls++
      return { environment: `M1\n- Current date: ${state.date}` }
    }
  })
  const s1 = await t.open('s1')
  t.kit.queue(answer('A1'))
  expect(await s1.submitUser('U1')).toEqual({})
  state.date = '2026-11-06'
  config.toolOverlay = ['mcp:new', 'mcp:ctx']
  expect((await s1.reconfigureAgent()).applied).toBe(true)
  t.kit.queue(answer('A2'))
  expect(await s1.submitUser('U2')).toEqual({})
  state.date = '2026-11-07'
  t.kit.queue(answer('A3'))
  expect(await s1.submitUser('U3')).toEqual({})
  expect(t.kit.requests.at(-1)!.tools.map((tool) => tool.name)).toEqual([...E_W, 'mcp__new__fresh'])
  expect(state.calls).toBe(1)
  const entries = (await allEntries(await s1.currentConversation())).filter(
    (entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant'
  )
  return {
    t,
    vars: { state },
    ids: { u1: entries[0]!.id as number, a1: entries[1]!.id as number }
  }
}
