/**
 * 子会话全链路（设计：docs/sub-session-design.md）——
 * 父会话的模型调 `session` 工具 → 建出一条**普通会话** → 代替用户往里发消息（只回执，§20：派活一律后台）→
 * 子会话自己跑一轮 → 跑完由完成通知把父会话叫回来（空闲则自动续跑），答复经 `wait-for-sub-sessions` 收回。
 *
 * 被测的是那条「不该有第二份」的路径：工具 → subSessionRunner → **chatGateway.prompt**
 * （IPC `agent:prompt` 的同一个函数）→ 子会话运行时。所以这里刻意不 mock 任何一层，
 * 只把模型换成脚本化的假 provider：父会话与子会话各自发的请求按 `lastUserText` 认领。
 *
 * 侧栏那一面只有一条产品差异：子会话缩进渲染在父行下面（`data-sub` / `data-sub-count`
 * 两个锚点，见 pages.ts）。
 *
 * P3-14-24：后台那一轮在父会话的任务页里是一条子会话行（落到 done）；它的「打开」把活动会话换成子会话，
 * 对话区从子会话自己的视图画出答复。
 *
 * 子会话的那一轮一律挂在具名 hold 槽 `child` 里、按需放行：假提供商立刻作答，不按住的话它可能在父会话的下一步
 * 之前就跑完 —— 完成通知是自动续跑一轮还是插进当前轮、`wait` 有没有握着它，全凭时序。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  autoAllowed,
  createProject,
  installAutoAllow,
  seedFakeProvider,
  waitRendererReady
} from '../../harness/seed'
import { sidebarPane, tasksPanelPane, type SidebarPane } from '../../harness/pages'
import { syncProbe, type SyncProbe } from '../../harness/sync'

const MODEL = 'e2e-model'
const PARENT_TITLE = 'S-parent'
const SUB_TITLE = '子任务 A'
/** 一轮挂在 hold 里的上限：远长于用例要它挂着的时间，放行靠 `release(key)` */
const HOLD_MS = 30_000
/**
 * 父会话的 `wait` 在视图里已经在跑之后，再留给它登记成「握着这条子会话」的余量（中间只隔两次 memo 读写）。
 * 完成通知在落定那一刻看「有没有 wait 握着」，所以放子会话跑完之前必须先过这一段
 */
const WAIT_ARMED_MS = 300
/** 否定断言的静默窗（> 自动续跑的合并窗口） */
const QUIET_MS = 1500

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
  metadata?: { isSystemNotice?: boolean } | null
  blocks?: Array<{
    type: string
    toolCallId?: string
    toolName?: string
    result?: string
    isError?: boolean
    details?: Record<string, unknown> | null
  }>
}

let app: E2EApp
let provider: FakeProvider
let probe: SyncProbe
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

/** 某次 session 工具调用的结果块（等它落盘） */
const sessionBlock = (
  sid: string,
  callId: string
): Promise<NonNullable<ListedMessage['blocks']>[number]> =>
  until(
    async () =>
      (await listMessages(sid))
        .flatMap((m) => m.blocks ?? [])
        .find((b) => b.toolCallId === callId && b.result !== undefined),
    `result of ${callId}`
  )

/** 系统通知（子会话回报父会话的那几条：role user + metadata.isSystemNotice） */
const systemNotices = (msgs: ListedMessage[]): ListedMessage[] =>
  msgs.filter((m) => m.role === 'user' && m.metadata?.isSystemNotice === true)

/** 请求认领：按最后一条用户消息的正文区分父会话与子会话 */
const byUserText =
  (text: string) =>
  (r: { lastUserText: string }): boolean =>
    r.lastUserText === text

/** 被子会话的完成通知叫醒的那一轮：末条用户消息就是那条通知 */
const wokenByCompletion = (r: { lastUserText: string }): boolean =>
  r.lastUserText.includes(`<sub-session id="${subSid}"`) && r.lastUserText.includes('has finished')

/** 等子会话的那一轮挂进 `child` 槽（它收到的用户消息恰为 text） */
const childHeld = (text: string): Promise<unknown> =>
  until(
    () => provider.heldRequest('child')?.lastUserText === text || null,
    `child turn "${text}" held`
  )

/** 等父会话的某次 wait 真的挂上了（视图里在跑 + 登记余量） */
const waitArmed = async (callId: string): Promise<void> => {
  await probe.waitView(
    parentSid,
    (v) => v.toolRuns[callId]?.status === 'running',
    30_000,
    `${callId} running`
  )
  await sleep(WAIT_ARMED_MS)
}

/** 等父会话转写里出现这段助手正文、且这一轮落定（续跑那一轮不是 agent.prompt 发起的，不能等它的返回） */
const waitParentSettled = (text: string): Promise<unknown> =>
  probe.waitView(
    parentSid,
    (v) =>
      v.run.state !== 'busy' &&
      v.messages.some((m) => m.role === 'assistant' && m.content.includes(text)),
    60_000,
    `"${text}" in the parent`
  )

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
  probe = syncProbe(app.main)
  await probe.install()
  // 开子会话出厂不问（2026-10-01 删了 ask-on-sub-session）。「点允许一次」的桩只当安全网：
  // 真冒出一张卡也不会把整条 spec 挂到超时 —— 用例里断言它一次都没被用上
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
    // 开子会话不问：安全网一次都没被用上
    expect(await autoAllowed(app.main)).toEqual([])
  })

  it('它就是一条普通会话：既不是笔记本也不是聊天会话，自己有一条空转写', async () => {
    const settings = await app.main.eval<Record<string, unknown>>(
      `window.api.session.getById(${JSON.stringify(subSid)}).then((s) => s.settings)`
    )
    expect(settings.notebookPath).toBeUndefined()
    // 聊天会话的判据是 `bot`（群聊时代的 `bots` 只是遗留键，新会话从不写它）
    expect(settings.bot).toBeUndefined()
    expect(settings.bots).toBeUndefined()
    expect(await listMessages(subSid)).toEqual([])
  })
})

describe('prompt-sub-session —— 派活只回执，跑完叫回父会话（§20）', () => {
  it('BG-E1 回执不带答复；子会话跑完 → 恰一条完成通知叫醒空闲的父会话 → 一次 wait 收回答复', async () => {
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
      // 子会话自己的那一轮（它收到的用户消息就是「干活」）：挂住，父会话那一轮先收尾
      { text: 'CHILD DONE.', when: byUserText('干活'), holdMs: HOLD_MS, holdKey: 'child' },
      { text: 'dispatched.', when: byUserText('让它干活') },
      // 被完成通知叫醒的那一轮：照通知说的，用 wait 收
      {
        toolCalls: [
          {
            id: 'call_collect',
            name: 'session',
            args: JSON.stringify({ action: 'wait-for-sub-sessions' })
          }
        ],
        when: wokenByCompletion
      },
      { text: 'collected.', when: wokenByCompletion }
    )
    // 父会话这一轮落定（回执、收尾）时子会话还挂着
    await promptParent('让它干活')
    await childHeld('干活')

    // 1. 回执：在跑、带后台标签，**不带**答复（子会话这时候也还没答）
    const receipt = await sessionBlock(parentSid, 'call_prompt')
    expect(receipt.isError).toBeFalsy()
    expect(receipt.result).toContain(`<sub-session id="${subSid}" status="running"/>`)
    expect(receipt.result).toContain('Started in the background')
    expect(receipt.result).not.toContain('CHILD DONE.')
    expect(receipt.result).not.toContain('<reply>')
    expect((receipt.details as { background?: boolean } | null | undefined)?.background).toBe(true)
    expect(systemNotices(await listMessages(parentSid))).toEqual([])

    // 2. 放子会话跑完 → 完成通知 → 空闲的父会话自动续跑那一轮
    provider.release('child')
    await waitParentSettled('collected.')

    // 子会话的转写：一条用户消息（父级代发）+ 一条助手答复，与人手敲的一模一样
    const childMsgs = await listMessages(subSid)
    expect(childMsgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(childMsgs[0].content).toBe('干活')
    expect(childMsgs[1].content).toContain('CHILD DONE.')

    // 3. 恰一条系统通知：说跑完了、指向 wait，本身不带答复
    const parentMsgs = await listMessages(parentSid)
    const notices = systemNotices(parentMsgs)
    expect(notices).toHaveLength(1)
    expect(notices[0].content).toContain(`<sub-session id="${subSid}"`)
    expect(notices[0].content).toContain('has finished')
    expect(notices[0].content).toContain('wait-for-sub-sessions')
    expect(notices[0].content).not.toContain('CHILD DONE.')
    // 模型以 user 角色看到的就是它
    const woken = provider.requests().filter(wokenByCompletion)
    expect(woken).toHaveLength(2)
    expect(woken[0].lastUserText.trim()).toBe(notices[0].content.trim())

    // 4. 收回来的答复**在围栏里** —— 围栏外的字都是工具在说话
    const collected = await sessionBlock(parentSid, 'call_collect')
    expect(collected.isError).toBeFalsy()
    expect(collected.result).toContain('<sub-sessions status="settled">')
    expect(collected.result).toContain(`<sub-session id="${subSid}"`)
    expect(collected.result).toContain('<reply>\nCHILD DONE.\n</reply>')
  })

  it('同一轮里 wait 收回：回执**不带答复正文**，一次 wait 交回答复、不另发完成通知', async () => {
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
              message: '后台干活'
            })
          }
        ],
        when: byUserText('后台跑')
      },
      // 挂住，等父会话的 wait 握着它了再放：落定在同一轮里交回，不通知
      { text: 'BG DONE.', when: byUserText('后台干活'), holdMs: HOLD_MS, holdKey: 'child' },
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
    // P3-14-24：父会话在渲染端是活动会话 —— 任务页只给活动会话画
    await until(
      async () => (await sidebar.openSession(PARENT_TITLE)) || null,
      'parent session opened'
    )
    const noticesBefore = systemNotices(await listMessages(parentSid)).length
    const turn = promptParent('后台跑').catch((error: unknown) => error)
    await childHeld('后台干活')
    await waitArmed('call_wait')
    provider.release('child')
    await turn
    await waitParentSettled('collected.')

    const results = toolResults(await listMessages(parentSid))
    // 按调用 id 认这一次的回执：上一条用例的回执同样在父会话里，文案也一样
    const receipt = (await sessionBlock(parentSid, 'call_bg')).result ?? ''
    expect(receipt).toContain('Started in the background')
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

    // wait 握着的那次落定已经在同一轮里交回：没有新的完成通知（也就没有被它叫醒的一轮）
    await sleep(QUIET_MS)
    expect(systemNotices(await listMessages(parentSid))).toHaveLength(noticesBefore)
    expect(provider.requests().filter((r) => r.lastUserText.includes('has finished'))).toEqual([])

    await until(
      async () => (await listMessages(subSid)).some((m) => m.content.includes('BG DONE.')),
      'background turn finished in the sub-session'
    )

    // P3-14-24：父会话的任务页里有一条子会话行，状态落到 done
    const tasks = tasksPanelPane(app.main)
    await tasks.open()
    await until(
      async () =>
        (await tasks.rows()).some(
          (r) => r.kind === 'sub-session' && r.title === SUB_TITLE && r.status === 'done'
        ) || null,
      'sub-session task row done'
    )
  })

  it('P3-14-24 任务页那条子会话行的「打开」：活动会话换成子会话，对话区从它自己的会话视图画出 BG DONE.', async () => {
    const tasks = tasksPanelPane(app.main)
    expect(await tasks.openSubSession(SUB_TITLE)).toBe(true)
    await until(
      async () => (await sidebar.activeTitle()) === SUB_TITLE || null,
      'sub-session became active'
    )
    await until(
      () =>
        app.main.eval<boolean>(
          `(document.querySelector('.conversation-scroller')?.textContent ?? '').includes('BG DONE.')`
        ),
      'BG DONE. rendered from the sub-session view'
    )
    // 回到父会话（后面的用例按父会话的侧栏状态断言）
    expect(await sidebar.openSession(PARENT_TITLE)).toBe(true)
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
