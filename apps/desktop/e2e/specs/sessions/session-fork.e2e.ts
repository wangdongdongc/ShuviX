/**
 * 会话 fork（侧栏行菜单「分支会话」`fork-session` / 回复上的「从这里分支」`[data-fork-reply]`）在真实应用里。
 * 契约：chat-protocol `sessionFork.ts`（谁能 fork、参数、拒绝原因），宿主 `services/sessionFork.ts`。
 *
 *   E-1 侧栏：两轮脚本对话的项目会话（空闲）→ 行菜单里 fork-session 可点 → 选它：同一个项目里多出
 *       「<标题> · fork」并成为活动会话；`message.list` 的 id 与文本和源会话一模一样，源会话不变；
 *       `agent.init(fork).created` 为 false；在 fork 里发一条，假提供商收到的是抄来的历史 + 新消息，
 *       源会话照旧只有它自己的两轮
 *   E-2 回复：第一轮一次 `ls`（项目目录）+ 终答、第二轮纯文本；点第一张卡的 [data-fork-reply] → 活动会话
 *       切到 fork，只有那一张卡（工具块带结果）；fork 的下一次请求带着工具结果、没有第二轮；源会话两张卡
 *       都在。IPC 给一个不存在的回复 id → `invalid_target`，会话列表不变
 *   E-3 旧格式（只读，`harness-v3-jsonl`）项目会话：行菜单里没有 fork-session、IPC 回 `not_forkable`、
 *       对话区一颗 [data-fork-reply] 都没有
 *   E-4 子会话的 fork 挂在同一个父会话下（侧栏嵌在父行下），钉着的档案（`settings.agentProfile`）随之保留，
 *       fork 里的下一次请求用的还是那份档案的系统提示
 *   E-5 临时会话（不属于任何项目）的 fork 与源会话**共用工作目录**（源会话的 `temp_workspace/<源 id>`）：
 *       临时组的行菜单里 fork-session 可点 → fork 落在临时组、成为活动会话，`settings.workingDirectory` 与
 *       `getById().workingDirectory` 都是源会话的目录；源会话的回复上有分支按钮；fork 里按抄来的历史里的
 *       绝对路径、按相对路径读那个文件都不问、不报错，相对路径写的文件落在源会话的目录里；沙箱可用时
 *       受限的 `cat` 也读得到（不问）；fork 的系统提示里写的工作目录就是源会话的目录。删源会话：目录与
 *       文件都留着，fork 照样读得到；再删 fork：目录没了，也没有 `temp_workspace/<fork id>`
 *
 * 夹具：一个项目、一个假提供商（脚本一律按用户消息认领，自动标题不会来抢 —— 源会话都有非默认标题，
 * fork 的「· fork」标题也不是默认标题）。旧格式会话在**运行中**种（`seedLegacySteps`：会话建了、从没打开过，
 * 视图第一次订阅时才按存储类型分流），之后再建的会话各带一次列表广播，渲染端的列表因此拿到它的 storageKind。
 * 主进程界面语言写成 en（fork 标题按 en 的 `agent.forkTitle` 比）；渲染端语言不随 IPC 设置变，菜单 label
 * 按三语里任一份比。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '../../../../../packages/chat-protocol/src/i18n/locales/en.json'
import ja from '../../../../../packages/chat-protocol/src/i18n/locales/ja.json'
import zh from '../../../../../packages/chat-protocol/src/i18n/locales/zh.json'
import { until } from '../../harness/cdp'
import {
  messageTextsOf,
  startFakeProvider,
  toolTextsOf,
  type FakeProvider,
  type FakeRequest
} from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'
import {
  autoAllowed,
  createPinnedChildSession,
  createProject,
  installAutoAllow,
  listSessionIds,
  newSessionsAfter,
  requestSystemText,
  sandboxAvailable,
  seedFakeProvider,
  seedLegacySteps,
  setSandboxEnabled,
  waitRendererReady
} from '../../harness/seed'

const MODEL = 'e2e-model'
const PROJ = 'ForkProj'
/** ls 的结果里要能认出来的那个文件 */
const MARKER = 'fork-marker-file.txt'
const FORK_LABELS = [en.sidebar.forkSession, zh.sidebar.forkSession, ja.sidebar.forkSession]

const forkTitleOf = (title: string): string => en.agent.forkTitle.replace('{{title}}', title)

const T = {
  e1: 'E1 fork source',
  e2: 'E2 reply source',
  e3: 'E3 legacy source',
  e4parent: 'E4 parent',
  e4child: 'E4 pinned child'
} as const

const Q = {
  e1a: 'E1 first question',
  e1b: 'E1 second question',
  e1c: 'E1 asked in the fork',
  e2a: 'E2 list the project',
  e2b: 'E2 second question',
  e2c: 'E2 asked in the fork',
  e4a: 'E4 child question',
  e4b: 'E4 asked in the fork'
} as const

const A = {
  e1a: 'E1 FIRST ANSWER',
  e1b: 'E1 SECOND ANSWER',
  e1c: 'E1 FORK ANSWER',
  e2a: 'E2 LISTED',
  e2b: 'E2 SECOND ANSWER',
  e2c: 'E2 FORK ANSWER',
  e4a: 'E4 CHILD ANSWER',
  e4b: 'E4 FORK ANSWER'
} as const

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  blocks?: ListedBlock[]
}

interface ListedBlock {
  type: string
  toolName?: string
  toolCallId?: string
  result?: string
  isError?: boolean
  details?: { sandbox?: string }
}

interface ListedSession {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  storageKind?: string
  settings: Record<string, unknown>
  /** getById 的计算属性（项目根 → settings.workingDirectory → 临时工作区） */
  workingDirectory?: string
}

type ForkResult = { success: true; sessionId: string } | { success: false; reason: string }

let app: E2EApp
let provider: FakeProvider
let sidebar: SidebarPane
let chat: ChatPane
let projDir = ''
let projectId = ''
const sid: Record<'e1' | 'e2' | 'e3' | 'e4parent' | 'e4child', string> = {
  e1: '',
  e2: '',
  e3: '',
  e4parent: '',
  e4child: ''
}

const createSession = (params: Record<string, unknown>): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify(params)}).then((s) => s.id)`)

const getSession = (id: string): Promise<ListedSession | null> =>
  app.main.eval<ListedSession | null>(`window.api.session.getById(${JSON.stringify(id)})`)

const listMessages = (id: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(id)})`)

/** 发一轮并等它落定（durable 的 submitUser 等这一轮落定才答） */
const prompt = (id: string, text: string): Promise<unknown> =>
  app.main.eval(`window.api.agent.prompt(${JSON.stringify({ sessionId: id, text })})`)

const fork = (params: { sessionId: string; messageId?: string }): Promise<ForkResult> =>
  app.main.eval<ForkResult>(`window.api.session.fork(${JSON.stringify(params)})`)

const init = (id: string): Promise<{ success: boolean; created: boolean }> =>
  app.main.eval(`window.api.agent.init(${JSON.stringify({ sessionId: id })})`)

const byUserText =
  (text: string) =>
  (r: FakeRequest): boolean =>
    r.lastUserText === text

/** 消息的身份 + 文本（fork 是整拷：id 也一样） */
const shapeOf = (msgs: ListedMessage[]): Array<Pick<ListedMessage, 'id' | 'role' | 'content'>> =>
  msgs.map((m) => ({ id: m.id, role: m.role, content: m.content }))

/** 一次请求里的对话（system 之外）：`role:text`，工具结果单独看 */
const conversationOf = (req: FakeRequest): string[] =>
  messageTextsOf(req)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role}:${m.text}`)

/** 最近一次（从 `since` 起）最后一条用户消息是 `text` 的请求 */
const requestFor = (text: string, since: number): FakeRequest | undefined =>
  provider
    .requests()
    .slice(since)
    .filter((r) => r.lastUserText === text)
    .at(-1)

const sortedIds = async (): Promise<string[]> => [...(await listSessionIds(app.main))].sort()

const waitRow = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)

const waitActive = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.activeTitle()) === title, `"${title}" is the active session`)

beforeAll(async () => {
  provider = await startFakeProvider()
  app = await launchApp()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  sidebar = sidebarPane(app.main)
  chat = chatPane(app.main)

  projDir = join(app.home, 'proj-fork')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, MARKER), 'marker\n')
  projectId = (await createProject(app.main, { name: PROJ, path: projDir })).id

  // E-3 的旧格式行最先种：建了、从没打开过，改库要赶在第一次打开之前；之后的每一次 create 都广播列表变化，
  // 渲染端重拉的列表里它就是旧格式
  sid.e3 = await createSession({ title: T.e3, projectId })
  seedLegacySteps(app, sid.e3, [
    { kind: 'user', text: 'E3 old question' },
    { kind: 'text', text: 'E3 OLD ANSWER' }
  ])

  // E-1：两轮纯文本
  sid.e1 = await createSession({ title: T.e1, projectId })
  provider.script(
    { text: A.e1a, when: byUserText(Q.e1a), usage: { prompt: 80, completion: 5 } },
    { text: A.e1b, when: byUserText(Q.e1b), usage: { prompt: 90, completion: 5 } }
  )
  await prompt(sid.e1, Q.e1a)
  await prompt(sid.e1, Q.e1b)

  // E-2：第一轮 ls + 终答，第二轮纯文本
  sid.e2 = await createSession({ title: T.e2, projectId })
  provider.script(
    {
      toolCalls: [{ id: 'call_e2_ls', name: 'ls', args: JSON.stringify({ path: projDir }) }],
      when: byUserText(Q.e2a),
      usage: { prompt: 80, completion: 5 }
    },
    { text: A.e2a, when: byUserText(Q.e2a), usage: { prompt: 95, completion: 5 } },
    { text: A.e2b, when: byUserText(Q.e2b), usage: { prompt: 110, completion: 5 } }
  )
  await prompt(sid.e2, Q.e2a)
  await prompt(sid.e2, Q.e2b)

  // E-4：父会话先在列表里出现，再建钉着 coding 档案的子会话（侧栏的自动展开要「父行上一帧就在」）
  sid.e4parent = await createSession({ title: T.e4parent, projectId })
  await waitRow(T.e4parent)
  sid.e4child = await createPinnedChildSession(app, {
    parentSid: sid.e4parent,
    agentProfile: 'coding',
    title: T.e4child
  })
  provider.script({ text: A.e4a, when: byUserText(Q.e4a), usage: { prompt: 80, completion: 5 } })
  await prompt(sid.e4child, Q.e4a)

  for (const title of [T.e1, T.e2, T.e3, T.e4parent]) await waitRow(title)
  await sidebar.setGroupExpanded({ project: PROJ }, true)
}, 180_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('session fork', () => {
  it('E-1 the sidebar fork copies the whole conversation into an active sibling that runs on its own', async () => {
    const srcMsgs = await listMessages(sid.e1)
    expect(srcMsgs.map((m) => `${m.role}:${m.content}`)).toEqual([
      `user:${Q.e1a}`,
      `assistant:${A.e1a}`,
      `user:${Q.e1b}`,
      `assistant:${A.e1b}`
    ])

    const item = (await sidebar.rowMenuShots(T.e1))?.find((i) => i.id === 'fork-session')
    expect(item).toBeDefined()
    expect(item!.enabled).toBe(true)
    expect(FORK_LABELS).toContain(item!.label)

    const added = await newSessionsAfter(app.main, () => sidebar.pickRowMenu(T.e1, 'fork-session'))
    expect(added).toHaveLength(1)
    const forkId = added[0]
    const forkTitle = forkTitleOf(T.e1)
    expect(await getSession(forkId)).toMatchObject({
      title: forkTitle,
      projectId,
      parentId: null,
      storageKind: 'durable-sqlite-1'
    })

    // 建好就切过去，落在同一个项目组里
    await waitActive(forkTitle)
    expect(await sidebar.groupRows({ project: PROJ })).toContainEqual(
      expect.objectContaining({ title: forkTitle, active: true })
    )

    // 整拷：id 与文本一模一样；源会话不动；fork 还没有运行时
    expect(shapeOf(await listMessages(forkId))).toEqual(shapeOf(srcMsgs))
    expect(await listMessages(sid.e1)).toEqual(srcMsgs)
    expect(await init(forkId)).toMatchObject({ success: true, created: false })

    // 画出来的就是抄来的那两轮
    await chat.ready()
    await until(async () => {
      const items = await chat.settledItems()
      return items.length === 4 && items[3].text.includes(A.e1b)
    }, 'forked transcript painted')

    // 在 fork 里发一条：模型看到抄来的历史 + 新消息
    provider.script({ text: A.e1c, when: byUserText(Q.e1c), usage: { prompt: 120, completion: 5 } })
    const since = provider.requests().length
    await chat.typeAndSend(Q.e1c)
    await until(
      async () => (await listMessages(forkId)).some((m) => m.content === A.e1c),
      'reply landed in the fork'
    )
    const req = requestFor(Q.e1c, since)
    expect(req).toBeDefined()
    expect(conversationOf(req!)).toEqual([
      `user:${Q.e1a}`,
      `assistant:${A.e1a}`,
      `user:${Q.e1b}`,
      `assistant:${A.e1b}`,
      `user:${Q.e1c}`
    ])
    expect((await listMessages(forkId)).map((m) => m.content)).toEqual([
      Q.e1a,
      A.e1a,
      Q.e1b,
      A.e1b,
      Q.e1c,
      A.e1c
    ])
    // 两条各走各的：源会话还是它自己的两轮
    expect(await listMessages(sid.e1)).toEqual(srcMsgs)
  })

  it('E-2 forking from a reply takes the history up to that card (tool results included) and nothing after it', async () => {
    const srcMsgs = await listMessages(sid.e2)
    expect(srcMsgs.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'user',
      'assistant'
    ])
    const lsBlock = srcMsgs[1].blocks?.find((b) => b.toolName === 'ls')
    expect(lsBlock?.isError).not.toBe(true)
    expect(lsBlock?.result).toContain(MARKER)
    // 第一张卡 = [ls 那条, 终答]；卡的 data-msg-id 是它的最后一条
    const firstCardLast = srcMsgs[2]
    expect(firstCardLast.content).toBe(A.e2a)

    expect(await sidebar.openSession(T.e2)).toBe(true)
    await chat.ready()
    await until(async () => {
      const items = await chat.settledItems()
      return items.some((i) => i.text.includes(A.e2b))
    }, 'source transcript painted')
    // 每张定稿的卡都有一颗
    await until(async () => (await chat.forkReplyCount()) === 2, 'a fork button on both cards')

    const added = await newSessionsAfter(app.main, async () => {
      expect(await chat.clickForkReply(firstCardLast.id)).toBe(true)
    })
    expect(added).toHaveLength(1)
    const forkId = added[0]
    const forkTitle = forkTitleOf(T.e2)
    expect(await getSession(forkId)).toMatchObject({ title: forkTitle, projectId, parentId: null })
    await waitActive(forkTitle)

    // fork 里只有第一轮：用户消息 + 那一张卡（ls 带着结果）
    const forkMsgs = await listMessages(forkId)
    expect(shapeOf(forkMsgs)).toEqual(shapeOf(srcMsgs.slice(0, 3)))
    expect(forkMsgs[1].blocks?.find((b) => b.toolName === 'ls')?.result).toContain(MARKER)
    await until(async () => {
      const ids = (await chat.settledItems()).map((i) => i.id)
      return ids.length === 2 && ids[0] === srcMsgs[0].id && ids[1] === firstCardLast.id
    }, 'the fork shows one user message and one card')
    expect(await chat.toolRows()).toEqual([{ name: 'ls', status: 'done' }])

    // 源会话两张卡都在
    expect(await listMessages(sid.e2)).toEqual(srcMsgs)

    // fork 的下一次请求：带着工具结果，没有第二轮
    provider.script({ text: A.e2c, when: byUserText(Q.e2c), usage: { prompt: 120, completion: 5 } })
    const since = provider.requests().length
    await prompt(forkId, Q.e2c)
    const req = requestFor(Q.e2c, since)
    expect(req).toBeDefined()
    expect(toolTextsOf(req!).join('\n')).toContain(MARKER)
    const convo = conversationOf(req!)
    expect(convo.filter((m) => m.startsWith('user:'))).toEqual([`user:${Q.e2a}`, `user:${Q.e2c}`])
    expect(convo).toContain(`assistant:${A.e2a}`)
    expect(req!.raw).not.toContain(Q.e2b)
    expect(req!.raw).not.toContain(A.e2b)
    expect(await listMessages(sid.e2)).toEqual(srcMsgs)

    // 不在对话里的回复 id：被拒，什么都没建
    const before = await sortedIds()
    expect(await fork({ sessionId: sid.e2, messageId: '999999' })).toEqual({
      success: false,
      reason: 'invalid_target'
    })
    expect(await sortedIds()).toEqual(before)
  })

  it('E-3 a legacy read-only project session offers no fork and IPC refuses it', async () => {
    const legacy = await getSession(sid.e3)
    expect(legacy?.storageKind).toBe('harness-v3-jsonl')

    const legacyMenu = ((await sidebar.rowMenuShots(T.e3)) ?? []).map((i) => i.id ?? 'sep')
    expect(legacyMenu).toContain('export-session')
    expect(legacyMenu).not.toContain('fork-session')

    const before = await sortedIds()
    expect(await fork({ sessionId: sid.e3 })).toEqual({ success: false, reason: 'not_forkable' })
    expect(await sortedIds()).toEqual(before)

    // 对话区：旧格式视图上一颗分支按钮都没有
    expect(await sidebar.openSession(T.e3)).toBe(true)
    await until(async () => (await chat.legacyBanner()) !== null, 'legacy banner')
    await until(
      async () => (await chat.settledItems()).some((i) => i.text.includes('E3 OLD ANSWER')),
      'legacy transcript painted'
    )
    expect(await chat.forkReplyCount()).toBe(0)
  })

  it('E-4 forking a sub-session nests the fork under the same parent and keeps the pinned profile', async () => {
    const childMsgs = await listMessages(sid.e4child)
    expect(childMsgs.map((m) => m.content)).toEqual([Q.e4a, A.e4a])
    const childReq = requestFor(Q.e4a, 0)
    expect(childReq).toBeDefined()
    // 源子会话跑的确实是 coding（它的正文点名 explore 子代理，work / chat 的正文不提）—— 下面的「一字不差」才有意义
    expect(requestSystemText(childReq!)).toContain('**explore**')

    const added = await newSessionsAfter(app.main, () =>
      sidebar.pickRowMenu(T.e4child, 'fork-session')
    )
    expect(added).toHaveLength(1)
    const forkId = added[0]
    const forkTitle = forkTitleOf(T.e4child)
    const row = await getSession(forkId)
    expect(row).toMatchObject({ title: forkTitle, projectId, parentId: sid.e4parent })
    expect(row?.settings.agentProfile).toBe('coding')

    // 侧栏：嵌在同一个父行下
    await until(
      async () => (await sidebar.subTitles()).includes(forkTitle),
      'the fork is a sub-session row'
    )
    await until(
      async () => (await sidebar.subCountOf(T.e4parent)) === 2,
      'the parent row counts both sub-sessions'
    )
    await waitActive(forkTitle)
    expect(shapeOf(await listMessages(forkId))).toEqual(shapeOf(childMsgs))

    // 钉着的档案真的在用：fork 的请求与源子会话的系统提示一字不差（丢了钉子就会是 work 的提示）
    provider.script({ text: A.e4b, when: byUserText(Q.e4b), usage: { prompt: 100, completion: 5 } })
    const since = provider.requests().length
    await prompt(forkId, Q.e4b)
    const req = requestFor(Q.e4b, since)
    expect(req).toBeDefined()
    expect(requestSystemText(req!)).toBe(requestSystemText(childReq!))
    expect(conversationOf(req!)).toEqual([`user:${Q.e4a}`, `assistant:${A.e4a}`, `user:${Q.e4b}`])
    expect(await listMessages(sid.e4child)).toEqual(childMsgs)
  })

  describe('E-5 a temp session fork shares the source session working folder', () => {
    const E5 = {
      title: 'E5 temp source',
      shared: 'e5-shared.txt',
      sharedContent: 'E5-SHARED-CONTENT-7f3a\n',
      fromFork: 'from-fork.txt',
      fromForkContent: 'E5-FROM-FORK-91c2\n',
      q: {
        write: 'E5 write the shared file',
        read: 'E5 read it from the fork',
        writeRel: 'E5 write a file from the fork',
        bash: 'E5 cat it confined',
        after: 'E5 read it after the source is gone'
      },
      a: {
        write: 'E5 WRITTEN',
        read: 'E5 READ',
        writeRel: 'E5 FORK WROTE',
        bash: 'E5 CATTED',
        after: 'E5 STILL THERE'
      }
    } as const
    const USAGE = { prompt: 90, completion: 5 }
    /** 源会话 S、它的工作目录（`<userData>/temp_workspace/<S>`）、写进去的那个文件的绝对路径、fork F */
    let sId = ''
    let sDir = ''
    let sharedAbs = ''
    let fId = ''

    const call = (
      id: string,
      name: string,
      args: Record<string, unknown>
    ): { id: string; name: string; args: string } => ({ id, name, args: JSON.stringify(args) })

    /** 会话里落库的那个工具块（`message.list` 的卡里，按 toolCallId 找） */
    const blockOf = async (sessionId: string, toolCallId: string): Promise<ListedBlock> => {
      const block = (await listMessages(sessionId))
        .flatMap((m) => m.blocks ?? [])
        .find((b) => b.toolCallId === toolCallId)
      expect(block, `tool block ${toolCallId} in ${sessionId}`).toBeDefined()
      return block!
    }

    /** 一个工具块：成功、结果里有 `text` */
    const expectToolOk = async (
      sessionId: string,
      toolCallId: string,
      text: string
    ): Promise<ListedBlock> => {
      const block = await blockOf(sessionId, toolCallId)
      expect(block.isError, `${toolCallId} failed: ${block.result}`).not.toBe(true)
      expect(block.result).toContain(text)
      return block
    }

    /** 请求里（抄来的历史）助手发过的某个工具的调用参数，按序 */
    const historyToolArgs = (req: FakeRequest, name: string): Array<Record<string, unknown>> =>
      (
        (req.body.messages ?? []) as Array<{
          tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
        }>
      )
        .flatMap((m) => m.tool_calls ?? [])
        .filter((c) => c.function?.name === name)
        .map((c) => JSON.parse(c.function?.arguments ?? '{}') as Record<string, unknown>)

    const tempWorkspaceOf = (id: string): string => join(app.userData, 'temp_workspace', id)

    const deleteSession = (id: string): Promise<unknown> =>
      app.main.eval(`window.api.session.delete(${JSON.stringify(id)})`)

    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    beforeAll(async () => {
      // 沙箱按会话固定（bash 工具建好时定）：在 fork 的运行时建出来之前钉成开（缺省也是开，写明而已）
      await setSandboxEnabled(app.main, true)
      // 安全网：这一路本不该问 —— 真冒出一张卡也不会挂到超时，而是在 autoAllowed 里现形
      await installAutoAllow(app.main)

      sId = await createSession({ title: E5.title })
      const src = await getSession(sId)
      sDir = src?.workingDirectory ?? ''
      sharedAbs = join(sDir, E5.shared)
      provider.script(
        {
          toolCalls: [
            call('call_e5_write', 'write', { path: sharedAbs, content: E5.sharedContent })
          ],
          when: byUserText(E5.q.write),
          usage: USAGE
        },
        { text: E5.a.write, when: byUserText(E5.q.write), usage: USAGE }
      )
      await prompt(sId, E5.q.write)
      await waitRow(E5.title)
    })

    it('E-5.0 the source is a temp session working in its own temp workspace, with the file on disk', async () => {
      const src = await getSession(sId)
      expect(src).toMatchObject({
        projectId: null,
        parentId: null,
        storageKind: 'durable-sqlite-1'
      })
      expect(sDir).toBe(tempWorkspaceOf(sId))
      const write = await blockOf(sId, 'call_e5_write')
      expect(write.isError, `write failed: ${write.result}`).not.toBe(true)
      expect(readFileSync(sharedAbs, 'utf8')).toBe(E5.sharedContent)
      expect(await autoAllowed(app.main)).toEqual([])
    })

    it('E-5.1 the temp group row menu forks it into an active temp sibling on the same folder', async () => {
      const item = (await sidebar.rowMenuShots(E5.title))?.find((i) => i.id === 'fork-session')
      expect(item).toBeDefined()
      expect(item!.enabled).toBe(true)
      expect(FORK_LABELS).toContain(item!.label)

      const srcMsgs = await listMessages(sId)
      const added = await newSessionsAfter(app.main, () =>
        sidebar.pickRowMenu(E5.title, 'fork-session')
      )
      expect(added).toHaveLength(1)
      fId = added[0]
      const forkTitle = forkTitleOf(E5.title)
      const row = await getSession(fId)
      expect(row).toMatchObject({ title: forkTitle, projectId: null, parentId: null })
      expect(row?.settings.workingDirectory).toBe(sDir)
      expect(row?.workingDirectory).toBe(sDir)
      expect(shapeOf(await listMessages(fId))).toEqual(shapeOf(srcMsgs))

      await waitActive(forkTitle)
      await until(async () => {
        const rows = await sidebar.groupRows('temp')
        return rows.some((r) => r.title === forkTitle && r.active)
      }, 'the fork is the active row of the temp group')
      expect(await sidebar.groupRows('temp')).toContainEqual(
        expect.objectContaining({ title: E5.title, active: false })
      )
    })

    it('E-5.2 the temp source shows a fork button on its reply', async () => {
      expect(await sidebar.openSession(E5.title)).toBe(true)
      await chat.ready()
      await until(
        async () => (await chat.settledItems()).some((i) => i.text.includes(E5.a.write)),
        'temp source transcript painted'
      )
      await until(async () => (await chat.forkReplyCount()) >= 1, 'a fork button on the reply')
    })

    it('E-5.3 the fork reads the shared file by the absolute path from its history and by a relative path, without asking', async () => {
      const when = byUserText(E5.q.read)
      provider.script(
        {
          // 绝对路径从 fork 收到的（抄来的）历史里取 —— 源会话那次 write 的参数
          build: (req) => {
            const path = historyToolArgs(req, 'write')[0]?.path
            if (typeof path !== 'string') throw new Error('no write call in the copied history')
            return { toolCalls: [call('call_e5_read_abs', 'read', { path })] }
          },
          when,
          usage: USAGE
        },
        { toolCalls: [call('call_e5_read_rel', 'read', { path: E5.shared })], when, usage: USAGE },
        { text: E5.a.read, when, usage: USAGE }
      )
      const since = provider.requests().length
      await prompt(fId, E5.q.read)

      const first = provider
        .requests()
        .slice(since)
        .find((r) => r.lastUserText === E5.q.read)
      expect(first).toBeDefined()
      expect(first!.buildError).toBeUndefined()
      expect(historyToolArgs(first!, 'write')[0]?.path).toBe(sharedAbs)

      await expectToolOk(fId, 'call_e5_read_abs', 'E5-SHARED-CONTENT-7f3a')
      await expectToolOk(fId, 'call_e5_read_rel', 'E5-SHARED-CONTENT-7f3a')
      expect((await listMessages(fId)).at(-1)?.content).toBe(E5.a.read)
      expect(await autoAllowed(app.main)).toEqual([])
    })

    it('E-5.4 a relative write in the fork lands in the source session folder', async () => {
      const when = byUserText(E5.q.writeRel)
      provider.script(
        {
          toolCalls: [
            call('call_e5_write_rel', 'write', {
              path: E5.fromFork,
              content: E5.fromForkContent
            })
          ],
          when,
          usage: USAGE
        },
        { text: E5.a.writeRel, when, usage: USAGE }
      )
      await prompt(fId, E5.q.writeRel)
      const block = await blockOf(fId, 'call_e5_write_rel')
      expect(block.isError, `write failed: ${block.result}`).not.toBe(true)
      expect(readFileSync(join(sDir, E5.fromFork), 'utf8')).toBe(E5.fromForkContent)
      expect(existsSync(join(tempWorkspaceOf(fId), E5.fromFork))).toBe(false)
      expect(await autoAllowed(app.main)).toEqual([])
    })

    it('E-5.5 a confined cat in the fork reads the shared file without asking', async (ctx) => {
      if (!(await sandboxAvailable(app.main))) ctx.skip()
      const when = byUserText(E5.q.bash)
      provider.script(
        {
          toolCalls: [
            call('call_e5_cat', 'bash', {
              command: `cat ${E5.shared}`,
              description: 'e2e temp fork cat'
            })
          ],
          when,
          usage: USAGE
        },
        { text: E5.a.bash, when, usage: USAGE }
      )
      await prompt(fId, E5.q.bash)
      const block = await expectToolOk(fId, 'call_e5_cat', 'E5-SHARED-CONTENT-7f3a')
      expect(block.details?.sandbox).toBe('confined')
      expect(await autoAllowed(app.main)).toEqual([])
    })

    it("E-5.6 the fork's system prompt names the source session folder as its working directory", () => {
      const req = requestFor(E5.q.read, 0)
      expect(req).toBeDefined()
      const system = requestSystemText(req!)
      const labels = ['Working directory', '工作目录', '作業ディレクトリ']
      expect(labels.some((label) => system.includes(`${label}: ${sDir}`))).toBe(true)
      expect(system).not.toContain(tempWorkspaceOf(fId))
    })

    it('E-5.7 deleting the source keeps the shared folder and its files, and the fork still reads them', async () => {
      await deleteSession(sId)
      expect(await listSessionIds(app.main)).not.toContain(sId)
      expect(existsSync(sDir)).toBe(true)
      expect(readFileSync(sharedAbs, 'utf8')).toBe(E5.sharedContent)
      expect(readFileSync(join(sDir, E5.fromFork), 'utf8')).toBe(E5.fromForkContent)
      expect((await getSession(fId))?.workingDirectory).toBe(sDir)

      const when = byUserText(E5.q.after)
      provider.script(
        { toolCalls: [call('call_e5_after_rel', 'read', { path: E5.shared })], when, usage: USAGE },
        { toolCalls: [call('call_e5_after_abs', 'read', { path: sharedAbs })], when, usage: USAGE },
        { text: E5.a.after, when, usage: USAGE }
      )
      await prompt(fId, E5.q.after)
      await expectToolOk(fId, 'call_e5_after_rel', 'E5-SHARED-CONTENT-7f3a')
      await expectToolOk(fId, 'call_e5_after_abs', 'E5-SHARED-CONTENT-7f3a')
      expect(await autoAllowed(app.main)).toEqual([])
      // 共用的目录在删源会话之后依旧在
      expect(existsSync(sDir)).toBe(true)
    })

    it('E-5.8 deleting the fork, the last session on the folder, removes it', async () => {
      await deleteSession(fId)
      expect(await listSessionIds(app.main)).not.toContain(fId)
      expect(existsSync(sDir)).toBe(false)
      expect(existsSync(tempWorkspaceOf(fId))).toBe(false)
      // 删完之后没有谁又把它们建回来（迟到的异步收尾）
      await sleep(1000)
      expect(existsSync(sDir)).toBe(false)
      expect(existsSync(tempWorkspaceOf(fId))).toBe(false)
    })
  })
})
