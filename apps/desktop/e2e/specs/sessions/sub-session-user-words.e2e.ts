/**
 * 用户原话随派活附上（用户 2026-11-07 的裁定；chat-protocol userWords.ts、services/userWords.ts）——
 * 父会话往**自己的**子会话发消息、接收方档案声明了 `shuvix-user-words`（内置 coding 开着）时，宿主把用户在父会话里
 * 自己写的话原样附在父 agent 写的那段之后、发送方说明之前。整条链路不 mock：父会话的模型（假提供商脚本）调 `session`
 * 工具 → subSessionRunner 读父会话的转写 → chatGateway 拼进模型文本与显示侧车 → 子会话运行时。
 *
 *   UW-E1 第一次派活：子会话那一轮的模型全文 = 任务 + 引用块（scope=start，用户在父会话里说过的三句，旧 → 新）+ 认领上面那段
 *         的发送方说明；回执多一句「附上了 3 条」；子会话气泡里恰一枚 userWords 胶囊，气泡文字里没有用户的原话；游标写进子会话
 *   UW-E2 再派一次：只附上次之后用户新说的（scope=since-last），之前那三句不再附
 *   UW-E3 不收的档案（不点名 → 基座）：派活照旧只有任务 + 发送方说明，没有引用块
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  installAutoAllow,
  seedFakeProvider,
  waitRendererReady
} from '../../harness/seed'
import { sidebarPane } from '../../harness/pages'
import { syncProbe, type SyncProbe } from '../../harness/sync'

const MODEL = 'e2e-model'
const CODING_TITLE = 'UW coding'
const BASE_TITLE = 'UW base'
const SAID_1 = '先记一下：金额一律美元两位小数'
const SAID_2 = '开一个 coding 子会话'
const SAID_3 = '让它去做导出'
const SAID_4 = '补充：列名叫 stockValue'

interface ListedMessage {
  id: string
  role: string
  content: string
  metadata?: { inlineTokens?: Record<string, { type?: string; name?: string }> } | null
  blocks?: Array<{ toolCallId?: string; toolName?: string; result?: string }>
}

let app: E2EApp
let provider: FakeProvider
let probe: SyncProbe
let parentSid = ''
let codingSid = ''

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

const promptParent = (text: string): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(parentSid)}, text: ${JSON.stringify(text)} })`
  )

const byUserText =
  (text: string) =>
  (r: { lastUserText: string }): boolean =>
    r.lastUserText === text

/** 父会话这一轮落定、转写里有这段助手正文 */
const parentSettled = (text: string): Promise<unknown> =>
  probe.waitView(
    parentSid,
    (v) =>
      v.run.state !== 'busy' &&
      v.messages.some((m) => m.role === 'assistant' && m.content.includes(text)),
    60_000,
    `"${text}" in the parent`
  )

/** 子会话收到的那一轮请求（按去掉宿主附加之后的文字认领） */
const childRequest = (task: string): Promise<{ lastUserFullText: string }> =>
  until(() => provider.requests().find(byUserText(task)), `child request "${task}"`)

const sessionResult = (callId: string): Promise<string> =>
  until(
    async () =>
      (await listMessages(parentSid))
        .flatMap((m) => m.blocks ?? [])
        .find((b) => b.toolCallId === callId && b.result !== undefined)?.result,
    `result of ${callId}`
  )

const sessions = (): Promise<Array<{ id: string; title: string }>> =>
  app.main.eval(
    `window.api.session.list().then((ss) => ss.map((s) => ({ id: s.id, title: s.title })))`
  )

/** 父会话用 session 工具建一条子会话（`agent_profile` 缺省 = 基座）；交回它的 id */
async function createChild(say: string, title: string, profile?: string): Promise<string> {
  provider.script(
    {
      toolCalls: [
        {
          id: `call_create_${title}`,
          name: 'session',
          args: JSON.stringify({
            action: 'create-sub-session',
            title,
            ...(profile ? { agent_profile: profile } : {})
          })
        }
      ],
      when: byUserText(say)
    },
    { text: `created ${title}.`, when: byUserText(say) }
  )
  await promptParent(say)
  await parentSettled(`created ${title}.`)
  return until(async () => (await sessions()).find((s) => s.title === title)?.id, title)
}

/** 父会话派一句活给 `sid`；子会话答 `reply` */
async function dispatch(say: string, sid: string, task: string, reply: string): Promise<void> {
  provider.script(
    {
      toolCalls: [
        {
          id: `call_${task}`,
          name: 'session',
          args: JSON.stringify({ action: 'prompt-session', session_id: sid, message: task })
        }
      ],
      when: byUserText(say)
    },
    { text: reply, when: byUserText(task) },
    { text: `dispatched ${task}.`, when: byUserText(say) }
  )
  await promptParent(say)
  await parentSettled(`dispatched ${task}.`)
  await until(
    async () =>
      (await listMessages(sid)).some((m) => m.role === 'assistant' && m.content.includes(reply)),
    `${reply} in the child`
  )
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  const projDir = join(app.home, 'proj-uw')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'UwProj', path: projDir })
  parentSid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title: 'UW parent', projectId: project.id })}).then((s) => s.id)`
  )
  probe = syncProbe(app.main)
  await probe.install()
  await installAutoAllow(app.main)
}, 60_000)

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('用户原话随派活附上', () => {
  it('UW-E1 第一次派活：任务 + 引用块（三句，旧 → 新）+ 发送方说明；回执说附了 3 条；一枚胶囊；游标写下', async () => {
    provider.reset()
    provider.script({ text: '记下了。', when: byUserText(SAID_1) })
    await promptParent(SAID_1)
    await parentSettled('记下了。')
    codingSid = await createChild(SAID_2, CODING_TITLE, 'coding')

    await dispatch(SAID_3, codingSid, '做导出', 'CHILD DONE.')

    const full = (await childRequest('做导出')).lastUserFullText
    expect(
      full.startsWith('做导出\n\n<user-words from="parent-session" scope="start">\n'),
      full
    ).toBe(true)
    const block = full.slice(full.indexOf('<user-words'), full.indexOf('</user-words>'))
    const at = [SAID_1, SAID_2, SAID_3].map((said) => block.indexOf(`>\n${said}\n</message>`))
    expect(at.every((i) => i > 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(full).toMatch(
      /<\/user-words>\n\n\[Sent by your parent session \(id [^\n]*An agent there wrote this message, not the user — except the <user-words> block, which ShuviX quoted from the user\./
    )

    expect(await sessionResult('call_做导出')).toContain(
      "ShuviX attached 3 of the user's own messages from this session to it, verbatim"
    )

    const [userMsg] = await listMessages(codingSid)
    const quoted = Object.values(userMsg.metadata?.inlineTokens ?? {}).filter(
      (t) => t.type === 'user-words'
    )
    expect(quoted.map((t) => t.name)).toEqual(['3'])
    expect(await sidebarPane(app.main).openSession(CODING_TITLE)).toBe(true)
    const bubble = `document.querySelector('[data-msg-id=${JSON.stringify(userMsg.id)}]')`
    await until(
      () =>
        app.main.eval<boolean>(
          `${bubble}?.querySelectorAll('[data-token-kind="userWords"]').length === 1`
        ),
      'one user-words chip'
    )
    expect(await app.main.eval<string>(`${bubble}.textContent`)).not.toContain(SAID_1)

    const through = await app.main.eval<unknown>(
      `window.api.session.getById(${JSON.stringify(codingSid)}).then((s) => s.settings.userWordsThrough)`
    )
    expect(typeof through).toBe('number')
  })

  it('UW-E2 再派一次：只附上次之后新说的', async () => {
    provider.reset()
    await dispatch(SAID_4, codingSid, '再改一下', 'CHILD AGAIN.')
    const full = (await childRequest('再改一下')).lastUserFullText
    expect(full).toContain('<user-words from="parent-session" scope="since-last">')
    expect(full).toContain(`>\n${SAID_4}\n</message>`)
    for (const old of [SAID_1, SAID_2, SAID_3]) expect(full).not.toContain(old)
    expect(await sessionResult('call_再改一下')).toContain(
      "ShuviX attached 1 of the user's own message from this session"
    )
  })

  it('UW-E3 不点名档案（基座不收）：只有任务与发送方说明', async () => {
    provider.reset()
    const baseSid = await createChild('再开一个普通子会话', BASE_TITLE)
    await dispatch('让普通子会话也看看', baseSid, '看看', 'BASE DONE.')
    const full = (await childRequest('看看')).lastUserFullText
    expect(full).not.toContain('<user-words')
    expect(full.startsWith('看看\n\n[Sent by your parent session (id ')).toBe(true)
    expect(full).toContain('An agent there wrote this, not the user.')
    expect(await sessionResult('call_看看')).not.toContain('ShuviX attached')
  })
})
