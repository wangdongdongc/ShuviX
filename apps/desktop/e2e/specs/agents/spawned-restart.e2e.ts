/**
 * 派生 agent 熬过重启（P3-14-23；路由索引在根会话打开时重建，Q-P3-17）。
 *
 * 进程 1：根会话派发 restart-sub（A）并让它答完。`stop({keepHome})` + `launchApp({home})` = 真的重启：路由的
 * agentId 索引、任务枢纽都在内存里，全没了。进程 2 在侧栏打开根会话（渲染端订阅它的视图 → 主进程 peek 打开 →
 * `onSessionOpened` → 路由按这条会话的派生记录重建索引）。之后：
 *
 *  - `agent.monitorDetail(A)` 不为空，系统提示词里是 A 的档案正文；
 *  - 面板追问（`agent.subAgentPrompt`）答 `{success:true}`，假提供商收到一条带 A 正文、最后一条用户消息是
 *    `again` 的请求 —— 追问真的落进了 A 的子对话；
 *  - 事件收集器录到 `sub_session_end{sessionId:A}`；
 *  - 一个裸的 `window.api.sync` agent 订阅交回的快照里有这次回答（重启之前它会以 service_not_found 拒绝）。
 *
 * 面板上不凭空长出 A 的任务行（C2：重建只服务路由与视图），这里不断言面板。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServiceSubscribeCall } from '@earendil-works/chord'
import { CHAT_VIEW_SERVICE_ID } from '@shuvix/chat-protocol/sync'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writeAgentMd,
  type RecordedEvent
} from '../../harness/seed'
import { sidebarPane } from '../../harness/pages'
import { syncProbe } from '../../harness/sync'

const MODEL = 'e2e-model'
const BODY = 'RESTART CHILD BODY.'
const TITLE = 'spawn-restart-parent'

let app: E2EApp | undefined
let provider: FakeProvider

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  writeAgentMd(app, 'restart-sub', {
    description: 'e2e spawned agent that outlives a restart',
    tools: 'read',
    body: BODY
  })
})

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

const childRequest = (lastUser: string) => (r: { raw: string; lastUserText: string }) =>
  r.raw.includes(BODY) && r.lastUserText === lastUser

describe('派生 agent 熬过重启（P3-14-23）', () => {
  it('进程 2 打开根会话之后：monitorDetail、面板追问、sub_session_end、agent 视图都认得进程 1 的 A', async () => {
    const first = app!
    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_restart',
            name: 'agent',
            args: JSON.stringify({
              description: 'restart sub',
              name: 'restart-sub',
              prompt: 'first task'
            })
          }
        ],
        usage: { prompt: 90, completion: 8 }
      },
      { text: 'child first answer', usage: { prompt: 60, completion: 4 } },
      { text: 'root first finished', usage: { prompt: 120, completion: 4 } }
    )
    const rec1 = eventRecorder(first.main)
    await rec1.install()
    const sid = await first.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: TITLE })}).then((s) => s.id)`
    )
    await first.main.eval(
      `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: 'dispatch once' })`
    )
    const register = await rec1.waitFor<RecordedEvent>('sub_session_register')
    const A = register.sessionId
    await rec1.waitFor('sub_session_end', { sessionId: A })
    await until(async () => {
      const msgs = await first.main.eval<Array<{ content: string }>>(
        `window.api.message.list(${JSON.stringify(sid)})`
      )
      return msgs.some((m) => m.content.includes('root first finished')) || null
    }, 'root finished in process 1')

    // 活动会话换成另一条：重开时渲染端恢复的若是根会话，它一上来就被打开了（PIN-12 的前提就不成立）
    await first.main.eval(
      `window.api.session.create(${JSON.stringify({ title: 'spawn-restart-other' })}).then((s) => s.id)`
    )
    const sidebar1 = sidebarPane(first.main)
    await until(
      async () => (await sidebar1.openSession('spawn-restart-other')) || null,
      'other session opened before the restart'
    )

    // ── 重启 ──
    const home = first.home
    await first.stop({ keepHome: true })
    app = undefined
    app = await launchApp({ home })
    const main = app.main
    await waitRendererReady(main)

    // 根会话还没打开：agent 目标认不出（PIN-12）
    // 在页面里直接调。主进程的信封是 {ok:false, error:{code:'service_not_found'}}（syncWiringIntegration 的
    // P3-14-11 断了 code）；但预载层抛出的 Error 过 contextBridge 时只剩 message，`.code` 到不了渲染端 ——
    // 这里只能断「被拒、且是主进程认不出它」那句
    const call = createServiceSubscribeCall('e2e-early', CHAT_VIEW_SERVICE_ID, 'singleton')
    const before = await main.eval<string>(
      `window.api.sync
        .invoke(${JSON.stringify({ kind: 'agent', agentId: A })}, ${JSON.stringify(call)})
        .then(() => 'subscribed', (error) => String(error?.message ?? error))`
    )
    expect(before).toContain(`Unknown agent ${A}`)

    // 侧栏打开根会话 → peek → 重建
    const sidebar = sidebarPane(main)
    await until(
      async () => (await sidebar.openSession(TITLE)) || null,
      'parent opened after restart'
    )
    const detail = await until(
      () =>
        main.eval<{ systemPrompt: string } | null>(
          `window.api.agent.monitorDetail(${JSON.stringify(A)})`
        ),
      'monitor detail of A after the restart'
    )
    expect(detail.systemPrompt).toContain(BODY)

    const rec = eventRecorder(main)
    await rec.install()
    provider.script({
      text: 'child again answer',
      when: childRequest('again'),
      usage: { prompt: 60, completion: 4 }
    })
    const sent = await main.eval<{ success: boolean }>(
      `window.api.agent.subAgentPrompt({ subSessionId: ${JSON.stringify(A)}, text: 'again' })`
    )
    expect(sent).toEqual({ success: true })
    await until(
      () => provider.chatRequests().some(childRequest('again')) || null,
      'the follow-up reached the child conversation'
    )
    const end = await rec.waitFor<RecordedEvent>('sub_session_end', { sessionId: A })
    expect(end.result).toBe('child again answer')
    expect(end.isError).toBe(false)

    const probe = syncProbe(main)
    const view = await probe.waitAgentView(
      A,
      (v) => v.messages.some((m) => m.content.includes('child again answer')),
      15_000,
      'agent view carries the reply'
    )
    expect(view.agentId).toBe(A)
    expect(view.sessionId).toBe(sid)
    expect(view.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'first task'],
      ['assistant', 'child first answer'],
      ['user', 'again'],
      ['assistant', 'child again answer']
    ])
  })
})
