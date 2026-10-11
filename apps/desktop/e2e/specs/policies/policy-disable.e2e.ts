/**
 * 内置安全策略的停用开关（md 扩展元数据，2026-10-10）—— 隔离实例 + 假提供商，停用的策略不参与装配
 * （「没有策略 = 放行」接手）。
 *
 *   PD-1 policy.list 的内置行带 objectId 与 disableable；内置行菜单有 toggle-enabled；卡片上的开关开着
 *   PD-2 基线：往会话目录以外写（家目录里的 outside/）要问（ask-on-external-path #1）
 *   PD-3 侧栏菜单停用它 → list disabled；同一种写入不问、文件落盘、工具结果不是错误
 *   PD-4 在卡片的开关上重新启用 → 又要问
 *   PD-5 ask-on-command（沙箱关着）：停用 → 沙箱外的命令直接跑、不问；重新启用 → 又要问
 *   PD-6 停用状态下建覆盖副本 → 副本行「已停用」、菜单有开关；写入照样不问
 *   PD-7 停用跨重启还在，写入照样不问 —— 放最后，它换了实例
 *
 * 询问装了 installAutoAllow 当安全网（扮演点「允许一次」的人），「问没问」数的是会话的 ask_count
 * （asksRaisedIn）—— 真冒出一张卡不会把 spec 挂到超时。会话一律自定义标题（默认标题会触发 auto-title，
 * 又是一路请求）；auto-review 由 harness 缺省关掉，脚本按 FIFO 即可。界面语言钉成 en。用例有顺序依赖。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { until } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  metaStripPane,
  policiesSidebarPane,
  registryNotePane,
  type MetaStripPane,
  type PoliciesSidebarPane,
  type RegistryNotePane
} from '../../harness/pages'
import {
  asksRaisedIn,
  createProject,
  eventRecorder,
  installAutoAllow,
  seedFakeProvider,
  setSandboxEnabled,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'

const MODEL = 'e2e-model'
const PATH_GATE = 'ask-on-external-path'
const COMMAND_GATE = 'ask-on-command'

interface PolicyRow {
  name: string
  source: 'builtin' | 'user'
  overridden?: boolean
  objectId?: string
  disableable?: boolean
  disabled?: boolean
}

interface ToolBlock {
  type: string
  toolCallId?: string
  result?: string
  isError?: boolean
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let pane: PoliciesSidebarPane
let note: RegistryNotePane
let strip: MetaStripPane
let projectId = ''
let outsideDir = ''
let markersDir = ''
let seq = 0

const listPolicies = (): Promise<PolicyRow[]> =>
  app.main.eval<PolicyRow[]>(
    `window.api.policy.list().then((ps) => ps.map((p) => ({
      name: p.name,
      source: p.source,
      overridden: p.overridden,
      objectId: p.objectId,
      disableable: p.disableable,
      disabled: p.disabled
    })))`
  )
const policyRow = async (
  name: string,
  source: 'builtin' | 'user'
): Promise<PolicyRow | undefined> =>
  (await listPolicies()).find((p) => p.name === name && p.source === source)

const newSession = (title: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const toolBlock = async (sid: string, toolCallId: string): Promise<ToolBlock | undefined> =>
  (
    await app.main.eval<Array<{ blocks?: ToolBlock[] }>>(
      `window.api.message.list(${JSON.stringify(sid)})`
    )
  )
    .flatMap((m) => m.blocks ?? [])
    .find((b) => b.type === 'tool' && b.toolCallId === toolCallId)

interface TurnOutcome {
  sid: string
  asks: number
  block: ToolBlock | undefined
}

/** 一条新会话、一轮脚本化的工具调用 + 收尾正文；等这一轮收尾，回问了几次与工具块 */
async function runToolTurn(
  label: string,
  call: { name: string; args: Record<string, unknown> }
): Promise<TurnOutcome> {
  const sid = await newSession(`${label}-${++seq}`)
  const callId = `call_${label.replace(/\W/g, '_')}_${seq}`
  provider.reset()
  provider.script(
    {
      toolCalls: [{ id: callId, name: call.name, args: JSON.stringify(call.args) }],
      usage: { prompt: 90, completion: 6 }
    },
    { text: 'done', usage: { prompt: 120, completion: 4 } }
  )
  await app.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: `run ${label}` })}).catch(() => undefined), true)`
  )
  await events.waitFor('agent_end', { sessionId: sid })
  return { sid, asks: await asksRaisedIn(events, sid), block: await toolBlock(sid, callId) }
}

const writeOutside = async (label: string): Promise<TurnOutcome & { path: string }> => {
  const path = join(outsideDir, `${label}-${seq + 1}.txt`)
  const outcome = await runToolTurn(label, {
    name: 'write',
    args: { path, content: `written by ${label}` }
  })
  return { ...outcome, path }
}

const touchUnconfined = async (label: string): Promise<TurnOutcome & { marker: string }> => {
  const marker = join(markersDir, `${label}-${seq + 1}.marker`)
  const outcome = await runToolTurn(label, {
    name: 'bash',
    args: { command: `touch ${marker}`, description: 'Create an empty marker file' }
  })
  return { ...outcome, marker }
}

async function launch(home?: string): Promise<void> {
  app = await launchApp(home ? { home } : {})
  if (!home) {
    // 命令要能问（沙箱里的命令不问）：任何会话起运行时之前关掉
    await setSandboxEnabled(app.main, false)
    await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  }
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  await installAutoAllow(app.main)
  pane = policiesSidebarPane(app.main)
  note = registryNotePane(app.main)
  strip = metaStripPane(app.main)
}

beforeAll(async () => {
  provider = await startFakeProvider()
  await launch()
  const projDir = join(app.home, 'proj-policy-disable')
  markersDir = join(projDir, 'markers')
  mkdirSync(markersDir, { recursive: true })
  projectId = (await createProject(app.main, { name: 'PolicyDisableProj', path: projDir })).id
  // 家目录里、会话目录以外：读写都问（写归 ask-on-external-path #1）
  outsideDir = join(app.home, 'outside-policy-disable')
  mkdirSync(outsideDir, { recursive: true })
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  await until(
    async () => (await pane.label()) === en.sidebar.policiesGroup,
    'renderer language is en'
  )
  await pane.expand()
})

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('内置安全策略的停用开关', () => {
  it('PD-1 内置行带 objectId 与 disableable；内置行菜单有 toggle-enabled；卡片上的开关开着', async () => {
    const builtins = (await listPolicies()).filter((p) => p.source === 'builtin')
    expect(builtins.map((p) => p.name).sort()).toEqual([COMMAND_GATE, PATH_GATE])
    for (const p of builtins) {
      expect(p, p.name).toMatchObject({ objectId: `policy:builtin:${p.name}`, disableable: true })
      expect(p.disabled, p.name).toBeUndefined()
    }
    const items = await pane.builtinRowMenu(PATH_GATE)
    expect(items?.map((i) => i.id)).toEqual(['create-override', 'toggle-enabled'])
    expect(items?.find((i) => i.id === 'toggle-enabled')?.label).toBe(en.common.disable)

    await pane.openBuiltin(PATH_GATE)
    await note.waitCard()
    await strip.waitStrip()
    expect(await strip.state()).toMatchObject({ state: 'on', disabledNote: null })
  })

  it('PD-2 基线：往会话目录以外写要问', async () => {
    const out = await writeOutside('pd2-baseline')
    expect(out.asks).toBe(1)
    // 安全网替用户点了允许：文件照样写进去
    expect(existsSync(out.path)).toBe(true)
  })

  it('PD-3 侧栏菜单停用 ask-on-external-path → list disabled；同一种写入不问、文件落盘、工具结果不是错误', async () => {
    await pane.pickBuiltinRowMenu(PATH_GATE, 'toggle-enabled')
    await until(async () => (await policyRow(PATH_GATE, 'builtin'))?.disabled === true, 'disabled')
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === PATH_GATE)
      return !!row && row.disabled && row.disabledBadge
    }, 'builtin row shows Disabled')

    const out = await writeOutside('pd3-disabled')
    expect(out.asks).toBe(0)
    expect(existsSync(out.path)).toBe(true)
    expect(readFileSync(out.path, 'utf8')).toBe('written by pd3-disabled')
    expect(out.block?.isError).toBeFalsy()
  })

  it('PD-4 在卡片开关上重新启用 → 又要问', async () => {
    await pane.openBuiltin(PATH_GATE)
    await note.waitCard()
    await strip.waitState('off')
    expect((await strip.state())?.disabledNote).toBe(en.notebook.frontmatter.metaPolicyDisabled)
    await strip.toggle()
    await strip.waitState('on')
    await until(
      async () => (await policyRow(PATH_GATE, 'builtin'))?.disabled === undefined,
      'enabled again'
    )
    const out = await writeOutside('pd4-enabled')
    expect(out.asks).toBe(1)
  })

  it('PD-5 ask-on-command（沙箱关着）：停用 → 沙箱外命令直接跑、不问；重新启用 → 又要问', async () => {
    const baseline = await touchUnconfined('pd5-baseline')
    expect(baseline.asks).toBe(1)

    await pane.pickBuiltinRowMenu(COMMAND_GATE, 'toggle-enabled')
    await until(
      async () => (await policyRow(COMMAND_GATE, 'builtin'))?.disabled === true,
      'ask-on-command disabled'
    )
    const disabled = await touchUnconfined('pd5-disabled')
    expect(disabled.asks).toBe(0)
    expect(existsSync(disabled.marker)).toBe(true)

    await pane.pickBuiltinRowMenu(COMMAND_GATE, 'toggle-enabled')
    await until(
      async () => (await policyRow(COMMAND_GATE, 'builtin'))?.disabled === undefined,
      'ask-on-command enabled again'
    )
    const enabled = await touchUnconfined('pd5-enabled')
    expect(enabled.asks).toBe(1)
  })

  it('PD-6 停用状态下建覆盖副本：副本行「已停用」、菜单有开关；写入照样不问', async () => {
    await pane.pickBuiltinRowMenu(PATH_GATE, 'toggle-enabled')
    await until(async () => (await policyRow(PATH_GATE, 'builtin'))?.disabled === true, 'disabled')
    await pane.pickBuiltinRowMenu(PATH_GATE, 'create-override')
    const copyPath = join(app.home, '.shuvix', 'policies', `${PATH_GATE}.md`)
    await until(() => existsSync(copyPath), 'override copy written')
    expect(readFileSync(copyPath, 'utf8')).toMatch(
      new RegExp(`^shuvix-id: policy:builtin:${PATH_GATE}$`, 'm')
    )
    await until(
      async () => (await policyRow(PATH_GATE, 'user'))?.disabled === true,
      'copy listed and disabled'
    )
    expect(await policyRow(PATH_GATE, 'builtin')).toMatchObject({
      overridden: true,
      disabled: true
    })
    await until(async () => {
      const row = (await pane.userRows()).find((r) => r.fileName === `${PATH_GATE}.md`)
      return !!row && row.disabled && row.disabledBadge && !row.struck
    }, 'copy row shows Disabled')
    expect(await pane.userRowMenuIds(`${PATH_GATE}.md`)).toEqual([
      'toggle-enabled',
      'delete-policy'
    ])

    const out = await writeOutside('pd6-copy')
    expect(out.asks).toBe(0)
    expect(existsSync(out.path)).toBe(true)
  })

  it('PD-7 停用跨重启还在，写入照样不问', async () => {
    const home = app.home
    await app.stop({ keepHome: true })
    await launch(home)
    await until(
      async () => (await policyRow(PATH_GATE, 'builtin'))?.disabled === true,
      'still disabled after restart'
    )
    expect((await policyRow(PATH_GATE, 'user'))?.disabled).toBe(true)
    const out = await writeOutside('pd7-restart')
    expect(out.asks).toBe(0)
    expect(existsSync(out.path)).toBe(true)
  })
})
