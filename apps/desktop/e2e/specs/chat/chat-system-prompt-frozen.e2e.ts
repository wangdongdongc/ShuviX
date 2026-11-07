/**
 * 系统提示词冻结 + 小图标提示 + 重建（2026-11-06，用户裁决「历史状态不变」）—— 单测 mock 掉的那半：真 IPC 通道
 * （`agent:systemPromptStatus` / `agent:rebuildSystemPrompt`）、真渲染端组件（输入卡片底部工具行里、用量环左边的
 * SystemPromptIndicator 与它的气泡）、真鼠标 / 真按键，与假提供商收到的系统提示词。
 *
 *   E-1  项目会话发第一条：请求里的系统提示词带项目提示词 P-OLD 与 AGENTS.md 的旧规则；没有小图标，状态 frozen
 *        且无变化
 *   E-2  在对话之外改项目提示词（project.update），窗口拿到焦点 → 小图标出现在用量环左边，`data-stale` =
 *        project_prompt；真鼠标点开气泡，说明里点名「project prompt」；Esc 收起
 *   E-3  再把 AGENTS.md 删掉、写一份 CLAUDE.md，切到别的会话（那边没有小图标）再切回来 → `data-stale` =
 *        project_instructions project_prompt，气泡里点名 CLAUDE.md；点到别处收起
 *   E-4  再发一条（挂住这一轮）：跑着的时候小图标还在，气泡里 [重建] 不可点、提示换成「等它停下」；请求仍是冻结的
 *        旧版本（P-OLD、AGENTS.md），与第一次逐字节相同；跑完小图标还在
 *   E-5  真鼠标点开气泡、点 [重建]：气泡收起，小图标消失，状态 frozen:false
 *   E-6  再发一条：请求换成新内容（P-NEW、CLAUDE.md 的新规则），旧内容不在；小图标不回来，状态 frozen 且无变化
 *
 * 模型侧由 fakeProvider 脚本化（按用户文字认领，自动标题等别的请求拿缺省回复）。一次 launchApp。
 * `SYSTEM_PROMPT_SHOT=<png 路径>` 时在 E-3 把输入卡片（小图标 + 开着的气泡）截一张给人看。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  startFakeProvider,
  type FakeProvider,
  type FakeRequest,
  type FakeTurn
} from '../../harness/fakeProvider'
import {
  createProject,
  requestSystemText,
  seedFakeProvider,
  waitRendererReady
} from '../../harness/seed'
import {
  chatPane,
  sidebarPane,
  systemPromptIndicatorPane,
  type ChatPane,
  type SidebarPane,
  type SystemPromptIndicatorPane
} from '../../harness/pages'
import { syncProbe } from '../../harness/sync'

const MODEL = 'e2e-model'
const TITLE = 'SP-frozen'
const OTHER = 'SP-other'
const USAGE = { prompt: 90, completion: 20 }
const P_OLD = 'P-OLD project prompt: answer in haiku.'
const P_NEW = 'P-NEW project prompt: answer in limericks.'
const RULE_OLD = 'RULE-OLD from AGENTS.md: use pnpm.'
const RULE_NEW = 'RULE-NEW from CLAUDE.md: use bun.'
const STALE_TITLE = "The system prompt's sources have changed"
const BUSY_HINT = 'The session is running. Rebuild once it stops.'
const SHOT = process.env.SYSTEM_PROMPT_SHOT

interface Status {
  frozen: boolean
  stale: Array<{ key: string; file?: string }>
}

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let indicator: SystemPromptIndicatorPane
let projectId: string
let projDir: string
let sid: string

const status = (): Promise<Status> =>
  app.main.eval<Status>(`window.api.agent.systemPromptStatus(${JSON.stringify(sid)})`)

/** 根会话那一轮的请求（按用户文字认；自动标题之类的请求不算） */
const requestFor = (text: string): FakeRequest | undefined =>
  provider.chatRequests().find((req) => req.lastUserText === text)

/** 在输入框里发一条（不等） */
async function startSend(text: string, turn: Partial<FakeTurn> = {}): Promise<string> {
  const reply = `re:${text}`
  provider.script({ text: reply, usage: USAGE, when: (req) => req.lastUserText === text, ...turn })
  await chat.typeAndSend(text)
  return reply
}

/** 等这一轮跑完、答复落进视图，交回那次请求的系统提示词 */
async function finishSend(text: string, reply: string): Promise<string> {
  await syncProbe(app.main).waitView(
    sid,
    (v) => v.run.state === 'idle' && v.messages.some((m) => m.content === reply),
    30_000,
    `answer to ${text}`
  )
  const req = await until(async () => requestFor(text) ?? null, `request for ${text}`)
  return requestSystemText(req)
}

async function send(text: string): Promise<string> {
  return finishSend(text, await startSend(text))
}

/** 窗口重新拿到焦点（多半是在别的编辑器里改完文件回来）：小图标挂在 window 的 focus 上重问 */
const focusWindow = (): Promise<unknown> =>
  app.main.eval(`(window.dispatchEvent(new Event('focus')), true)`)

beforeAll(async () => {
  provider = await startFakeProvider()
  app = await launchApp()
  // 文案断言用英文
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-frozen')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'AGENTS.md'), RULE_OLD)
  projectId = (
    await createProject(app.main, { name: 'FrozenProj', path: projDir, systemPrompt: P_OLD })
  ).id
  const create = (title: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
    )
  // 标题不是缺省标题：自动标题不跑
  sid = await create(TITLE)
  await create(OTHER)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  indicator = systemPromptIndicatorPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => {
    const titles = await sidebar.titles()
    return titles.includes(TITLE) && titles.includes(OTHER)
  }, 'sidebar rows')
  provider.reset()
}, 120_000)

afterAll(async () => {
  provider?.release()
  await app?.stop()
  await provider?.close()
})

describe('frozen system prompt: indicator and rebuild', () => {
  it('E-1 the first send in a project session carries the old project prompt and AGENTS.md; no indicator, frozen with nothing stale', async () => {
    expect(await sidebar.openSession(TITLE)).toBe(true)
    await chat.ready()
    // 还没建过 agent：没冻结，没有可提示的
    expect(await status()).toEqual({ frozen: false, stale: [] })

    const system = await send('first')
    expect(system).toContain(P_OLD)
    expect(system).toContain('<project_instructions file="AGENTS.md">')
    expect(system).toContain(RULE_OLD)

    expect(await status()).toEqual({ frozen: true, stale: [] })
    await focusWindow()
    await sleep(800)
    expect(await indicator.indicator()).toBeNull()
  })

  it('E-2 the project prompt is changed outside the chat; on focus the indicator appears left of the context ring and its popover names the project prompt', async () => {
    expect(
      await app.main.eval(
        `window.api.project.update(${JSON.stringify({ id: projectId, systemPrompt: P_NEW })})`
      )
    ).toEqual({ success: true })
    expect(await status()).toEqual({ frozen: true, stale: [{ key: 'project_prompt' }] })

    await focusWindow()
    const shot = await until(
      async () => (await indicator.indicator()) ?? null,
      'indicator on focus'
    )
    expect(shot).toEqual({
      stale: ['project_prompt'],
      label: STALE_TITLE,
      expanded: false,
      beforeContextRing: true
    })
    expect(await indicator.popover()).toBeNull()

    const popover = await indicator.openPopover()
    expect(popover.text).toContain('project prompt')
    expect(popover.text).not.toContain('instruction')
    expect(popover.hint).not.toBe(BUSY_HINT)
    expect(popover.rebuildDisabled).toBe(false)
    expect((await indicator.indicator())?.expanded).toBe(true)

    await indicator.pressEscape()
    await until(async () => (await indicator.popover()) === null || null, 'popover closed by Esc')
    expect((await indicator.indicator())?.expanded).toBe(false)
  })

  it('E-3 AGENTS.md removed and CLAUDE.md written; after switching away and back the popover names CLAUDE.md', async () => {
    rmSync(join(projDir, 'AGENTS.md'))
    writeFileSync(join(projDir, 'CLAUDE.md'), RULE_NEW)
    expect(await status()).toEqual({
      frozen: true,
      stale: [{ key: 'project_instructions', file: 'CLAUDE.md' }, { key: 'project_prompt' }]
    })

    expect(await sidebar.openSession(OTHER)).toBe(true)
    await chat.ready()
    // 别的会话没建过 agent：没有小图标
    await sleep(500)
    expect(await indicator.indicator()).toBeNull()
    expect(await sidebar.openSession(TITLE)).toBe(true)
    await chat.ready()
    const shot = await until(async () => {
      const current = await indicator.indicator()
      return current && current.stale.length === 2 ? current : null
    }, 'indicator with both sources after switching back')
    expect(shot.stale).toEqual(['project_instructions', 'project_prompt'])
    expect(shot.beforeContextRing).toBe(true)

    const popover = await indicator.openPopover()
    expect(popover.text).toContain('CLAUDE.md')
    expect(popover.text).toContain('project prompt')
    expect(popover.text).not.toContain('AGENTS.md')
    if (SHOT) await indicator.screenshotComposer(SHOT, 16)

    await indicator.clickOutside()
    await until(
      async () => (await indicator.popover()) === null || null,
      'popover closed by a click outside'
    )
    expect(await indicator.indicator()).not.toBeNull()
  })

  it('E-4 while the next turn runs the indicator stays and Rebuild is disabled; the request still carries the frozen old version', async () => {
    const reply = await startSend('second', { holdMs: 30_000 })
    await until(() => provider.holding() || null, 'second turn holding')
    expect(await chat.isBusy()).toBe(true)
    const during = await indicator.indicator()
    expect(during?.stale).toEqual(['project_instructions', 'project_prompt'])
    const popover = await indicator.openPopover()
    expect(popover.rebuildDisabled).toBe(true)
    expect(popover.hint).toBe(BUSY_HINT)
    await indicator.pressEscape()
    await until(async () => (await indicator.popover()) === null || null, 'popover closed')

    provider.release()
    const system = await finishSend('second', reply)
    expect(system).toContain(P_OLD)
    expect(system).toContain('<project_instructions file="AGENTS.md">')
    expect(system).toContain(RULE_OLD)
    expect(system).not.toContain(P_NEW)
    expect(system).not.toContain(RULE_NEW)
    // 与第一次请求逐字节相同
    expect(system).toBe(requestSystemText(requestFor('first')!))

    await until(async () => {
      const after = await indicator.indicator()
      return after && after.stale.length === 2 ? after : null
    }, 'indicator after the run')
    const after = await indicator.openPopover()
    expect(after.rebuildDisabled).toBe(false)
    expect(after.hint).not.toBe(BUSY_HINT)
    await indicator.pressEscape()
    await until(async () => (await indicator.popover()) === null || null, 'popover closed')
  })

  it('E-5 a real click opens the popover and a real click on Rebuild: the popover closes, the indicator goes away, the session is no longer frozen', async () => {
    await indicator.openPopover()
    await indicator.clickRebuild()
    await until(
      async () => (await indicator.indicator()) === null || null,
      'indicator gone after rebuild'
    )
    expect(await indicator.popover()).toBeNull()
    expect(await status()).toEqual({ frozen: false, stale: [] })
    // 没有在别处又冒出来
    await focusWindow()
    await sleep(800)
    expect(await indicator.indicator()).toBeNull()
  })

  it('E-6 the send after the rebuild carries the new project prompt and CLAUDE.md; no indicator comes back', async () => {
    const system = await send('third')
    expect(system).toContain(P_NEW)
    expect(system).toContain('<project_instructions file="CLAUDE.md">')
    expect(system).toContain(RULE_NEW)
    expect(system).not.toContain(P_OLD)
    expect(system).not.toContain(RULE_OLD)
    expect(system).not.toContain('AGENTS.md">')

    expect(await status()).toEqual({ frozen: true, stale: [] })
    await focusWindow()
    await sleep(800)
    expect(await indicator.indicator()).toBeNull()
  })
})
