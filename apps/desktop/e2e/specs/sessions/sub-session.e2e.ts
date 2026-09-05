/**
 * 子会话全链路（设计：docs/sub-session-design.md）——
 * 父会话的模型调 `session` 工具 → 建出一条**普通会话** → 代替用户往里发消息 →
 * 子会话自己跑一轮 → 答复回到父会话的工具结果里。
 *
 * 被测的是那条「不该有第二份」的路径：工具 → subSessionRunner → **chatGateway.prompt**
 * （IPC `agent:prompt` 的同一个函数）→ 子会话运行时。所以这里刻意不 mock 任何一层，
 * 只把模型换成脚本化的假 provider：父会话与子会话各自发的请求按 `lastUserText` 认领。
 *
 * 侧栏那一面只有一条产品差异：子会话缩进渲染在父行下面（`data-sub` / `data-sub-count`
 * 两个锚点，见 pages.ts）。
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
import { sidebarPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'
const PARENT_TITLE = 'S-parent'
const SUB_TITLE = '子任务 A'

interface SessionRow {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
}

interface ListedMessage {
  id: string
  role: string
  content: string
  blocks?: Array<{ type: string; toolName?: string; result?: string; isError?: boolean }>
}

let app: E2EApp
let provider: FakeProvider
let sidebar: SidebarPane
let projectId = ''
let parentSid = ''
let subSid = ''

const sessions = (): Promise<SessionRow[]> =>
  app.main.eval<SessionRow[]>(`window.api.session.list()`)

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 父会话发一条用户消息（走 IPC agent:prompt，与用户在输入框里敲完全同一条路） */
const promptParent = (text: string): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(parentSid)}, text: ${JSON.stringify(text)} })`
  )

/** 工具块的结果文本（父会话转写里 session 工具那一块） */
const toolResults = (msgs: ListedMessage[]): string[] =>
  msgs.flatMap((m) =>
    (m.blocks ?? []).filter((b) => b.toolName === 'session').map((b) => b.result ?? '')
  )

/** 请求认领：按最后一条用户消息的正文区分父会话与子会话 */
const byUserText =
  (text: string) =>
  (r: { lastUserText: string }): boolean =>
    r.lastUserText === text

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const projDir = join(app.home, 'proj-sub')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'SubProj', path: projDir })
  projectId = project.id
  parentSid = await app.main.eval<string>(
    `window.api.session
      .create(${JSON.stringify({ title: PARENT_TITLE, projectId: project.id })})
      .then((s) => s.id)`
  )
  sidebar = sidebarPane(app.main)
  // 内置 ask-on-sub-session 对「开子会话」要问一句 —— e2e 里没人看着，扮演那个点
  // 「允许一次」的用户。这条用例测的是子会话机制，不是那道门（门本身在 policies 区）
  await installAutoAllow(app.main)
}, 60_000)

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('create-sub-session', () => {
  it('模型调工具 → 建出一条普通会话：parentId 指向父级、项目继承、标题即父级给的名字', async () => {
    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_create',
            name: 'session',
            args: JSON.stringify({ action: 'create-sub-session', title: SUB_TITLE })
          }
        ],
        when: byUserText('开一个子会话')
      },
      { text: 'created.', when: byUserText('开一个子会话') }
    )
    await promptParent('开一个子会话')

    const rows = await sessions()
    const sub = rows.find((s) => s.title === SUB_TITLE)
    expect(sub, '子会话应已建出').toBeDefined()
    subSid = sub!.id
    expect(sub!.parentId).toBe(parentSid)
    // 工作目录是会话的地基：子会话恒随父会话的项目
    expect(sub!.projectId).toBe(projectId)

    // 工具结果里带着 id —— 模型后续就是拿它来发消息的
    expect(toolResults(await listMessages(parentSid)).join('\n')).toContain(subSid)
  })

  it('它就是一条普通会话：既不是笔记本也不是群聊，自己有一条空转写', async () => {
    const settings = await app.main.eval<Record<string, unknown>>(
      `window.api.session.getById(${JSON.stringify(subSid)}).then((s) => s.settings)`
    )
    expect(settings.notebookPath).toBeUndefined()
    expect(settings.bots).toBeUndefined()
    expect(await listMessages(subSid)).toEqual([])
  })
})

describe('prompt-sub-session —— 代替用户发消息并等结果', () => {
  it('前台：子会话真的跑了一轮，答复回到父会话的工具结果里', async () => {
    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_prompt',
            name: 'session',
            args: JSON.stringify({
              action: 'prompt-sub-session',
              sub_session_id: subSid,
              message: '干活'
            })
          }
        ],
        when: byUserText('让它干活')
      },
      // 子会话自己的那一轮（它收到的用户消息就是「干活」）
      { text: 'CHILD DONE.', when: byUserText('干活') },
      { text: 'ok.', when: byUserText('让它干活') }
    )
    await promptParent('让它干活')

    // 子会话的转写：一条用户消息（父级代发）+ 一条助手答复，与人手敲的一模一样
    const childMsgs = await listMessages(subSid)
    expect(childMsgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(childMsgs[0].content).toBe('干活')
    expect(childMsgs[1].content).toContain('CHILD DONE.')

    // 父会话拿到的是子会话的最终答复，且**在围栏里** —— 围栏外的字都是工具在说话
    const parentResults = toolResults(await listMessages(parentSid)).join('\n')
    expect(parentResults).toContain('<reply>\nCHILD DONE.\n</reply>')
    expect(parentResults).toContain('<sub-session id="' + subSid + '"')
  })

  it('后台：立刻回执且**不带答复正文**，跑完再由 read 取', async () => {
    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_bg',
            name: 'session',
            args: JSON.stringify({
              action: 'prompt-sub-session',
              sub_session_id: subSid,
              message: '后台干活',
              run_in_background: true
            })
          }
        ],
        when: byUserText('后台跑')
      },
      { text: 'BG DONE.', when: byUserText('后台干活'), chunkDelayMs: 60 },
      // 父级随后用一次 wait 收结果 —— 替掉「sleep + 反复 list/read」的那条路
      {
        toolCalls: [
          {
            id: 'call_wait',
            name: 'session',
            args: JSON.stringify({ action: 'wait-for-sub-sessions' })
          }
        ],
        when: byUserText('后台跑')
      },
      { text: 'collected.', when: byUserText('后台跑') }
    )
    await promptParent('后台跑')

    const results = toolResults(await listMessages(parentSid))
    // 认那句独有的回执文案而不是「哪条结果里有 background 这个词」—— 创建回执里也有
    // （它要把 `run_in_background` 摆给模型看），松判据会挑中它
    const receipt = results.find((r) => r.includes('Started in the background')) ?? ''
    // 回执**明说跑完会把你叫回来**（自动续跑之后那是事实），并给出「要当轮就拿到答复」的收法
    expect(receipt).toContain('brought back')
    expect(receipt).toContain('wait-for-sub-sessions')
    // 回执不带内容：它会永久留在父会话上下文里并被每一步重发
    expect(receipt).not.toContain('BG DONE.')

    // wait 一次交回答复：父级不必再 read 一遍；答复同样在围栏里
    const collected = results.find((r) => r.includes('BG DONE.'))
    expect(collected, 'wait 应把子会话的答复一次交回').toBeDefined()
    expect(collected).toContain('<sub-sessions status="settled">')
    expect(collected).toContain('<reply>\nBG DONE.\n</reply>')

    await until(
      async () => (await listMessages(subSid)).some((m) => m.content.includes('BG DONE.')),
      'background turn finished in the sub-session'
    )
  })

  it('越权 id 被拒，错误里给出合法的子会话（模型才有下一步）', async () => {
    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_bad',
            name: 'session',
            args: JSON.stringify({
              action: 'prompt-sub-session',
              sub_session_id: parentSid,
              message: 'x'
            })
          }
        ],
        when: byUserText('乱发')
      },
      { text: 'sorry.', when: byUserText('乱发') }
    )
    await promptParent('乱发')

    const msgs = await listMessages(parentSid)
    const failed = msgs.flatMap((m) =>
      (m.blocks ?? []).filter((b) => b.toolName === 'session' && b.isError)
    )
    expect(failed.length).toBeGreaterThan(0)
    const text = failed.map((b) => b.result ?? '').join('\n')
    expect(text).toContain('is not a sub-session of this session')
    expect(text).toContain(subSid)
  })
})

describe('侧栏：唯一的产品差异', () => {
  it('子会话缩进渲染在父行下面，父行带数量徽标；平铺列表里不再重复出现', async () => {
    // 列表由 session.listChanged 广播驱动重拉；工具建的会话同样走这条路
    await until(async () => (await sidebar.titles()).includes(SUB_TITLE), 'sub-session listed')
    expect(await sidebar.subTitles()).toContain(SUB_TITLE)
    expect(await sidebar.subCountOf(PARENT_TITLE)).toBe(1)
    // 子行只出现一次（没有既平铺一遍又嵌套一遍）
    expect((await sidebar.titles()).filter((t) => t === SUB_TITLE)).toHaveLength(1)
  })

  it('新建的子会话自动展开父会话（缺省折叠，但刚建出来的那条必须立刻可见）', async () => {
    // 本轮之前 sidebar 一直挂着，子会话是这一轮才出现的 id —— 自动展开的判据正是它
    expect(await sidebar.subsStateOf(PARENT_TITLE)).toBe('expanded')
  })

  it('点行首图标折叠/展开（折叠只收高度，子行仍在 DOM 里 —— 所以判据是 data-subs）', async () => {
    expect(await sidebar.toggleSubs(PARENT_TITLE)).toBe(true)
    expect(await sidebar.subsStateOf(PARENT_TITLE)).toBe('collapsed')
    expect(await sidebar.toggleSubs(PARENT_TITLE)).toBe(true)
    expect(await sidebar.subsStateOf(PARENT_TITLE)).toBe('expanded')
  })
})

describe('删除父会话 —— 递归带走子会话', () => {
  it('删父之后两行都没了（补偿在确认框的数量提示，不在这一层）', async () => {
    await app.main.eval(`window.api.session.delete(${JSON.stringify(parentSid)})`)
    const ids = (await sessions()).map((s) => s.id)
    expect(ids).not.toContain(parentSid)
    expect(ids).not.toContain(subSid)
  })
})
