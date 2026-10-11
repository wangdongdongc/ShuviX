/**
 * 内置 hook 的停用开关（md 扩展元数据，2026-10-10）—— 隔离实例 + 假提供商，样本是内置 **auto-title**
 * （harness 缺省用同一个停用开关关掉了 auto-review，它的内置行在这里一开始就是停用的）。
 *
 *   HD-1 hook.list 的内置行带 objectId 与 disableable，只有 harness 停掉的 auto-review 是停用的；内置行菜单有 toggle-enabled（Disable）；
 *        auto-title 的只读笔记里「ShuviX 设置」条开关是开着的
 *   HD-2 侧栏菜单停用 → hook.list 里 disabled:true；行带 data-hook-disabled 与「已停用」徽标（不手动刷新）；
 *        菜单变成 Enable；mdMeta.get 的 enabled 为 false；开着的卡片翻成关、写着 metaHookDisabled
 *   HD-3 停用期间新会话的第一条 prompt：根会话这一轮照常收尾，没有 titler 的 run、标题仍是默认
 *   HD-4 在卡片的开关上启用 → 侧栏徽标消失（hook.changed）；新会话又拿到快速标题
 *   HD-6 停用状态下建覆盖副本 → 副本逐字照抄、带内置 id；用户行「已停用」、菜单 = toggle-enabled + delete-hook；
 *        内置行划线 + 已覆盖、不叠「已停用」；titler 仍不跑；在副本行上启用 → 两份一起启用；再停用后删掉副本 →
 *        内置恢复生效、仍是停用（开关挂在内置 id 上）
 *   HD-7 停用跨重启还在、照样不跑 —— 放最后，它换了实例
 *
 * 观测面同 autoTitle.e2e.ts：一次 hook run = 主窗口一条 `sub_session_register`（parentSessionId = 归属会话、
 * subAgentName = titler）；titler 的请求按内容认领（任务文本以内置正文开头、带 prompt-accepted 围栏与会话 id）。
 * 界面语言钉成 en。用例有顺序依赖。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { MdMetaNoteView } from '@shuvix/chat-protocol/mdMeta'
import { sleep, until } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  confirmPane,
  hooksSidebarPane,
  metaStripPane,
  policiesSidebarPane,
  registryNotePane,
  type ConfirmPane,
  type HooksSidebarPane,
  type MetaStripPane,
  type RegistryNotePane
} from '../../harness/pages'
import {
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'

const MODEL = 'e2e-model'
const SAMPLE = 'auto-title'
const SAMPLE_ID = 'hook:builtin:auto-title'
const PROMPT_ACCEPTED = 'session.prompt-accepted'
/** 内置 auto-title 的正文开头（各语言副本的正文都是这段英文） */
const TITLER_BODY = 'Derive one concise title'

interface HookItem {
  name: string
  source: 'builtin' | 'user'
  basePath: string
  overridden?: boolean
  objectId?: string
  disableable?: boolean
  disabled?: boolean
}

interface SessionRow {
  id: string
  title: string
}

interface RegisterEvent extends RecordedEvent {
  parentSessionId: string
  subAgentName: string
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let pane: HooksSidebarPane
let note: RegistryNotePane
let strip: MetaStripPane
let confirm: ConfirmPane

const listHooks = (): Promise<HookItem[]> => app.main.eval('window.api.hook.list()')
const hookRow = async (source: 'builtin' | 'user'): Promise<HookItem | undefined> =>
  (await listHooks()).find((h) => h.name === SAMPLE && h.source === source)
const metaGet = (sessionId: string): Promise<MdMetaNoteView | null> =>
  app.main.eval(`window.api.mdMeta.get(${JSON.stringify({ sessionId })})`)
const builtinNoteId = (): Promise<string> =>
  app.main.eval(
    `window.api.hook.openBuiltinNote(${JSON.stringify({ name: SAMPLE })}).then((s) => s.id)`
  )
const createSession = (): Promise<string> =>
  app.main.eval<string>(`window.api.session.create({}).then((s) => s.id)`)
const sessionOf = (sid: string): Promise<SessionRow> =>
  app.main.eval<SessionRow>(`window.api.session.getById(${JSON.stringify(sid)})`)

/** 发一轮并等根会话这一轮收尾（hook 的派发与这一轮并发） */
const promptTurn = async (sid: string, text: string): Promise<void> => {
  await app.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })}).catch(() => undefined), true)`
  )
  await events.waitFor('agent_end', { sessionId: sid })
}
const rootRequest =
  (text: string) =>
  (r: FakeRequest): boolean =>
    r.lastUserText === text
const titlerRequest =
  (sid: string) =>
  (r: FakeRequest): boolean =>
    r.lastUserText.startsWith(TITLER_BODY) &&
    r.lastUserText.includes(`<hook_event trigger="${PROMPT_ACCEPTED}">`) &&
    r.lastUserText.includes(sid)

let titleCallSeq = 0
/** titler 的两发：先 session set-title，再以标题正文作答收尾 */
const scriptTitler = (sid: string, title: string): void => {
  const when = titlerRequest(sid)
  provider.script(
    {
      toolCalls: [
        {
          id: `call_hd_title_${++titleCallSeq}`,
          name: 'session',
          args: JSON.stringify({ action: 'set-title', title })
        }
      ],
      when
    },
    { text: title, when }
  )
}

/** 这条会话名下 titler 的 run 登记 */
const titlerRegisters = async (sid: string): Promise<RegisterEvent[]> =>
  (await events.all()).filter(
    (e): e is RegisterEvent =>
      e.type === 'sub_session_register' &&
      (e as RegisterEvent).parentSessionId === sid &&
      (e as RegisterEvent).subAgentName === 'titler'
  )

/**
 * 停用期间的一轮：根会话照常收尾，过一会儿仍没有 titler 的 run、没有 titler 请求、日志里没有它的 start，
 * 标题仍是默认的
 */
async function expectNoTitler(text: string): Promise<void> {
  const sid = await createSession()
  const defaultTitle = (await sessionOf(sid)).title
  provider.script({ text: `${text}-reply`, when: rootRequest(text) })
  await promptTurn(sid, text)
  await sleep(1500)
  expect(await titlerRegisters(sid)).toEqual([])
  expect(provider.requests().filter(titlerRequest(sid))).toEqual([])
  expect(
    app
      .mainLog()
      .split('\n')
      .some((l) => l.includes(`hook "${SAMPLE}" run=`) && l.includes(`session=${sid}`))
  ).toBe(false)
  expect((await sessionOf(sid)).title).toBe(defaultTitle)
}

/** 起实例；复用 HOME 时提供商行与默认模型已在库里（假提供商一直在跑，地址不变），不再种一次 */
async function launch(home?: string): Promise<void> {
  app = await launchApp(home ? { home } : {})
  if (!home) await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  pane = hooksSidebarPane(app.main)
  note = registryNotePane(app.main)
  strip = metaStripPane(app.main)
  confirm = confirmPane(app.main)
}

beforeAll(async () => {
  provider = await startFakeProvider()
  await launch()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  // hooks 组的标签中英同为 "Hooks"，拿策略组的标签当语言落定的判据
  const policies = policiesSidebarPane(app.main)
  await until(
    async () => (await policies.label()) === en.sidebar.policiesGroup,
    'renderer language is en'
  )
  await pane.expand()
})

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('内置 hook 的停用开关', () => {
  it('HD-1 内置行带 objectId 与 disableable、只有 harness 停掉的 auto-review 停用；内置行菜单有 toggle-enabled（Disable）；卡片上的开关开着', async () => {
    const builtins = (await listHooks()).filter((h) => h.source === 'builtin')
    expect(builtins.map((h) => h.name).sort()).toEqual(['auto-review', 'auto-title'])
    for (const h of builtins) {
      expect(h, h.name).toMatchObject({ objectId: `hook:builtin:${h.name}`, disableable: true })
    }
    // harness 缺省就是拿这个开关关掉自动审查的（launchApp 的 autoReview）
    expect((await listHooks()).filter((h) => h.disabled).map((h) => h.name)).toEqual([
      'auto-review'
    ])

    const items = await pane.builtinRowMenu(SAMPLE)
    expect(items?.map((i) => i.id)).toEqual(['create-override', 'toggle-enabled'])
    expect(items?.find((i) => i.id === 'toggle-enabled')?.label).toBe(en.common.disable)
    const row = (await pane.builtinRows()).find((r) => r.name === SAMPLE)!
    expect([row.disabled, row.disabledBadge]).toEqual([false, false])

    await pane.openBuiltin(SAMPLE)
    await note.waitCard()
    await strip.waitStrip()
    expect(await strip.state()).toMatchObject({
      state: 'on',
      disabledNote: null,
      rows: ['enabled']
    })
  })

  it('HD-2 侧栏菜单停用 → list disabled、行带 data 属性与「已停用」徽标（不手动刷新）、菜单变 Enable、视图 enabled:false、开着的卡片翻成关', async () => {
    await pane.pickBuiltinRowMenu(SAMPLE, 'toggle-enabled')
    await until(async () => (await hookRow('builtin'))?.disabled === true, 'auto-title disabled')
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === SAMPLE)
      return !!row && row.disabled && row.disabledBadge && !row.struck
    }, 'builtin row shows Disabled without a manual refresh')

    const items = await pane.builtinRowMenu(SAMPLE)
    expect(items?.find((i) => i.id === 'toggle-enabled')?.label).toBe(en.common.enable)
    expect((await metaGet(await builtinNoteId()))?.enabled).toBe(false)

    await strip.waitState('off')
    expect((await strip.state())?.disabledNote).toBe(en.notebook.frontmatter.metaHookDisabled)
  })

  it('HD-3 停用期间：新会话第一条 prompt 照常收尾，没有 titler 的 run，标题仍是默认', async () => {
    await expectNoTitler('hello-while-disabled')
  })

  it('HD-4 在卡片开关上启用 → 侧栏徽标消失；新会话又拿到快速标题', async () => {
    await pane.openBuiltin(SAMPLE)
    await note.waitCard()
    await strip.waitState('off')
    await strip.toggle()
    await strip.waitState('on')
    await until(async () => (await hookRow('builtin'))?.disabled === undefined, 'enabled again')
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === SAMPLE)
      return !!row && !row.disabled && !row.disabledBadge
    }, 'sidebar badge gone after hook.changed')

    const sid = await createSession()
    provider.script({ text: 'r-enabled', when: rootRequest('hello-enabled') })
    scriptTitler(sid, 'Titled Again')
    await promptTurn(sid, 'hello-enabled')
    await until(async () => (await sessionOf(sid)).title === 'Titled Again', 'quick title applied')
    expect(await titlerRegisters(sid)).toHaveLength(1)
  })

  it('HD-6 停用状态下建覆盖副本：副本带内置 id 并一起停用；在副本行上启用两份一起启用；再停用后删掉副本 → 内置恢复生效、仍停用', async () => {
    await pane.pickBuiltinRowMenu(SAMPLE, 'toggle-enabled')
    await until(async () => (await hookRow('builtin'))?.disabled === true, 'disabled again')

    const source = await app.main.eval<{ text?: string }>(
      `window.api.hook.getSource(${JSON.stringify({ name: SAMPLE, source: 'builtin' })})`
    )
    await pane.pickBuiltinRowMenu(SAMPLE, 'create-override')
    const copyPath = join(app.hooksDir, `${SAMPLE}.md`)
    await until(() => existsSync(copyPath), 'override copy written')
    const copy = readFileSync(copyPath, 'utf8')
    expect(copy).toBe(source.text)
    expect(copy).toMatch(new RegExp(`^shuvix-id: ${SAMPLE_ID}$`, 'm'))

    await until(async () => (await hookRow('user'))?.disabled === true, 'copy listed, disabled')
    expect(await hookRow('user')).toMatchObject({ objectId: SAMPLE_ID, disableable: true })
    expect(await hookRow('builtin')).toMatchObject({ overridden: true, disabled: true })

    await until(async () => {
      const user = (await pane.userRows()).find((r) => r.fileName === `${SAMPLE}.md`)
      const builtin = (await pane.builtinRows()).find((r) => r.name === SAMPLE)
      return (
        !!user &&
        user.disabled &&
        user.disabledBadge &&
        !user.struck &&
        !!builtin &&
        builtin.struck &&
        builtin.badge &&
        builtin.disabled &&
        !builtin.disabledBadge
      )
    }, 'copy row Disabled; builtin row struck + Overridden, no Disabled badge')
    expect(await pane.userRowMenuIds(`${SAMPLE}.md`)).toEqual(['toggle-enabled', 'delete-hook'])

    await expectNoTitler('hello-copy-disabled')

    await pane.pickUserRowMenu(`${SAMPLE}.md`, 'toggle-enabled')
    await until(async () => {
      const [user, builtin] = await Promise.all([hookRow('user'), hookRow('builtin')])
      return user?.disabled === undefined && builtin?.disabled === undefined
    }, 'enabling from the copy row enables both')

    await pane.pickUserRowMenu(`${SAMPLE}.md`, 'toggle-enabled')
    await until(async () => (await hookRow('user'))?.disabled === true, 'copy disabled again')

    await pane.pickUserRowMenu(`${SAMPLE}.md`, 'delete-hook')
    await confirm.waitOpen()
    await confirm.confirm()
    await until(() => !existsSync(copyPath), 'override copy deleted')
    await until(async () => (await hookRow('user')) === undefined, 'copy gone from the list')
    const builtin = await hookRow('builtin')
    expect(builtin?.overridden).toBeUndefined()
    expect(builtin?.disabled).toBe(true)
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === SAMPLE)
      return !!row && !row.struck && row.disabled && row.disabledBadge
    }, 'builtin row back, still Disabled')
  })

  it('HD-7 停用跨重启还在，照样不跑', async () => {
    const home = app.home
    await app.stop({ keepHome: true })
    await launch(home)
    await until(async () => (await hookRow('builtin'))?.disabled === true, 'still disabled')
    await expectNoTitler('hello-after-restart')
  })
})
