/**
 * 默认思考等级（`general.defaultThinkingLevel`，设置 → 通用 → 默认模型）—— 没设过档位的会话用哪一档。
 *
 *   - DT-E-1 全新实例：键没写过，设置行五段、选中 medium；五段的文案与输入框思考选择器那一行逐个相同
 *     （同一份档位清单与文案键，按界面语言比，不认字面）；点 high / off → 设置里存下的就是它；
 *   - DT-E-2 只走 IPC、不跑模型：默认 high → 新建的会话（没设过档位）报 high，会话设置里不长出
 *     thinkingLevel；显式设成 off 的会话报 off；agent 建起来之后再改默认，它的档位不动（锁着），
 *     而一条新会话已经拿到新默认；
 *   - DT-E-3 重启后欢迎页的思考选择器种的就是设置里的默认档（xhigh）；不碰选择器直接发送，新会话
 *     **不存档位**（种下的是默认档、不是选择），交给后端回落 —— R 声明了推理，所以 init 报的、agent
 *     实际用的都是 xhigh；重新打开设置页仍显示 xhigh；
 *   - DT-E-4 再重启：欢迎页仍种 xhigh，只把模型换成没声明推理的 N、不碰档位就发送 → 新会话同样不存
 *     档位，后端按 N 的能力回落成 off（init 报 off、agent 用 off）—— 没标推理的模型不吃默认档。
 *
 * 夹具：假提供商的模型 R 种成默认，并把能力改成 reasoning（默认档只给声明了推理能力的模型）；同一
 * 提供商下另有模型 N（reasoning: false），只在 DT-E-4 选它。四个用例共用一个 HOME、按顺序接力；
 * DT-E-3 / DT-E-4 各真重启一次（`restart()`：`stop({ keepHome: true })` + `launchApp({ home })`）——
 * 主窗口 `location.reload()` 在 harness 里不可用，而欢迎页的档位只在应用启动时从设置种一次，发一次
 * 就被新会话的同步顶掉，所以每个「没动过就发送」的用例都得有自己的一次启动。
 * DOM 只经 pages.ts 的 defaultThinkingPane / modelPickerPane / chatPane。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SELECTABLE_THINKING_LEVELS } from '@shuvix/chat-protocol/types/thinking'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  eventRecorder,
  listSessionIds,
  newSessionsAfter,
  seedFakeProvider,
  waitRendererReady
} from '../../harness/seed'
import { chatPane, defaultThinkingPane, modelPickerPane } from '../../harness/pages'

const MODEL_R = 'e2e-model-reasoning'
/** 没声明推理能力的模型（DT-E-4） */
const MODEL_N = 'e2e-model-plain'
const KEY = 'general.defaultThinkingLevel'
const E3_TEXT = 'DT-E3 hello from the welcome page'
const E4_TEXT = 'DT-E4 hello from the welcome page with a plain model'

interface InitResult {
  success: boolean
  created: boolean
  model: string
  modelMetadata: { thinkingLevel?: string }
}

interface RuntimeInfo {
  model: { id: string }
  thinkingLevel: string
}

let app: E2EApp | undefined
let provider: FakeProvider | undefined
/** 假提供商的 id（R 与 N 都挂在它下面） */
let providerId = ''
/** DT-E-1 打开的设置窗口（DT-E-3 重启前还用它选 xhigh） */
let settings: CdpClient | undefined

const level = (name: string): number =>
  SELECTABLE_THINKING_LEVELS.indexOf(name as (typeof SELECTABLE_THINKING_LEVELS)[number])

const live = (): E2EApp => {
  if (!app) throw new Error('app not running')
  return app
}

// ─── IPC 助手 ───

const storedDefault = (): Promise<unknown> =>
  live().main.eval(`window.api.settings.get(${JSON.stringify(KEY)})`)

const setDefault = (value: string): Promise<unknown> =>
  live().main.eval(`window.api.settings.set(${JSON.stringify({ key: KEY, value })})`)

const createSession = (title: string): Promise<string> =>
  live().main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
  )

const sessionSettings = (id: string): Promise<Record<string, unknown>> =>
  live().main.eval(
    `window.api.session.getById(${JSON.stringify(id)}).then((s) => (s && s.settings) || {})`
  )

const init = (id: string): Promise<InitResult> =>
  live().main.eval<InitResult>(`window.api.agent.init({ sessionId: ${JSON.stringify(id)} })`)

const runtimeInfo = (id: string, ensure = false): Promise<RuntimeInfo | null> =>
  live().main.eval(
    `window.api.agent.getInfo(${JSON.stringify(id)}${ensure ? ', { ensure: true }' : ''})`
  )

const setThinking = (id: string, value: string): Promise<{ success: boolean }> =>
  live().main.eval(
    `window.api.agent.setThinkingLevel(${JSON.stringify({ sessionId: id, level: value })})`
  )

/** 给假提供商下的某个模型改能力 */
const setCapabilities = (
  modelId: string,
  capabilities: Record<string, unknown>
): Promise<unknown> =>
  live().main.eval(`(async () => {
    const providerId = ${JSON.stringify(providerId)}
    const row = (await window.api.provider.listModels(providerId)).find(
      (m) => m.modelId === ${JSON.stringify(modelId)}
    )
    await window.api.provider.updateModelCapabilities({
      id: row.id,
      capabilities: ${JSON.stringify(capabilities)}
    })
    return true
  })()`)

/**
 * 真重启（同一个 HOME）：先收走设置窗口，停进程留 HOME，再起一个新实例并等渲染层就绪。
 * 欢迎页的思考档位只在应用启动时种一次 —— 每个「没动过就发送」的用例都得从这里开始。
 */
async function restart(): Promise<CdpClient> {
  settings?.close()
  settings = undefined
  const home = live().home
  await live().stop({ keepHome: true })
  app = undefined
  app = await launchApp({ home })
  await waitRendererReady(app.main)
  return app.main
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  provider = await startFakeProvider()
  ;({ providerId } = await seedFakeProvider(app.main, {
    baseUrl: provider.baseUrl,
    modelId: MODEL_R
  }))
  // R 声明推理能力：默认档只给 reasoning 模型（其余一律 off）；默认模型仍是 R
  await setCapabilities(MODEL_R, { reasoning: true, maxInputTokens: 200000, maxOutputTokens: 4096 })
  // N 挂在同一个提供商下、明说不推理（DT-E-4 在欢迎页上换成它）
  await app.main.eval(
    `window.api.provider.addModel(${JSON.stringify({ providerId, modelId: MODEL_N })})`
  )
  await setCapabilities(MODEL_N, {
    reasoning: false,
    maxInputTokens: 200000,
    maxOutputTokens: 4096
  })
}, 120_000)

afterAll(async () => {
  settings?.close()
  await app?.stop()
  await provider?.close()
})

describe('默认思考等级：设置行 → 没设过档位的会话 → 重启后的欢迎页', () => {
  it('DT-E-1 全新实例：没写过键、设置行选中 medium；五段文案与输入框选择器逐个相同；点 high / off 存下来', async () => {
    expect(await storedDefault()).toBeFalsy()

    settings = await live().openSettings('general')
    const pane = defaultThinkingPane(settings)
    await pane.ready()
    const options = await pane.options()
    expect(options).toHaveLength(SELECTABLE_THINKING_LEVELS.length)
    expect(options.filter((o) => o.selected)).toHaveLength(1)
    expect(await pane.selectedIndex()).toBe(level('medium'))

    // ── 同一实例里输入框思考选择器那一行：档位次序即共享清单，文案逐个与设置行相同 ──
    const chat = chatPane(live().main)
    const models = modelPickerPane(live().main)
    await chat.ready()
    await until(models.present, 'model picker shows the seeded provider')
    await models.open()
    const picker = await until(async () => {
      const rows = await models.thinkingLevels()
      return rows.length > 0 ? rows : null
    }, 'thinking level row in the model panel')
    await models.close()
    expect(picker.map((p) => p.level)).toEqual([...SELECTABLE_THINKING_LEVELS])
    expect(options.map((o) => o.label)).toEqual(picker.map((p) => p.label))
    for (const o of options) expect(o.label).not.toBe('')

    // ── 点 high：存下 high、选中态跟过去 ──
    await pane.pick(level('high'))
    await until(async () => (await storedDefault()) === 'high', 'default stored as high')
    await until(async () => (await pane.selectedIndex()) === level('high'), 'segment high selected')

    // ── 点 off：off 也是一档（默认不思考），照样存下 ──
    await pane.pick(level('off'))
    await until(async () => (await storedDefault()) === 'off', 'default stored as off')
    await until(async () => (await pane.selectedIndex()) === level('off'), 'segment off selected')
  })

  it('DT-E-2 IPC：没设过档位的新会话报默认档、不写回会话；显式 off 照用；agent 建起来后改默认不动它', async () => {
    await setDefault('high')

    // (a) 没设过档位：报默认档 high，会话设置里没有 thinkingLevel
    const sidA = await createSession('DT-E2 never chose')
    const a = await init(sidA)
    expect(a.success).toBe(true)
    expect(a.model).toBe(MODEL_R)
    expect(a.modelMetadata.thinkingLevel).toBe('high')
    expect(await sessionSettings(sidA)).not.toHaveProperty('thinkingLevel')

    // (c) 显式设成 off 的会话：报 off，默认档不覆盖它
    const sidC = await createSession('DT-E2 chose off')
    expect((await setThinking(sidC, 'off')).success).toBe(true)
    expect((await init(sidC)).modelMetadata.thinkingLevel).toBe('off')

    // (d) agent 建起来（不请求模型）用的是 high；之后把默认改成 low，它不动（锁着）
    expect((await runtimeInfo(sidA, true))?.thinkingLevel).toBe('high')
    expect((await init(sidA)).created).toBe(true)
    await setDefault('low')
    expect(await storedDefault()).toBe('low')
    expect((await runtimeInfo(sidA))?.thinkingLevel).toBe('high')
    expect((await init(sidA)).modelMetadata.thinkingLevel).toBe('high')
    // 正控制组：新默认确实生效了 —— 一条新的没设过档位的会话已经报 low
    const sidD = await createSession('DT-E2 after the change')
    expect((await init(sidD)).modelMetadata.thinkingLevel).toBe('low')
  })

  it('DT-E-3 设置行选 xhigh → 重启：欢迎页选择器就是 xhigh；不碰它直接发送，新会话不存档位，init 与 agent 都回落到 xhigh（R 声明了推理）', async () => {
    expect(settings, 'DT-E-1 opened the settings window').toBeDefined()
    const before = defaultThinkingPane(settings!)
    await before.ready()
    await before.pick(level('xhigh'))
    await until(async () => (await storedDefault()) === 'xhigh', 'default stored as xhigh')

    // ── 真重启（同一个 HOME）──
    const main = await restart()
    const recorder = eventRecorder(main)
    await recorder.install()
    const chat = chatPane(main)
    const models = modelPickerPane(main)

    // ── 欢迎页：默认模型是 R，思考档位种的是 xhigh（恰一档选中）──
    await chat.ready()
    await until(async () => (await models.currentModel()) === MODEL_R, 'trigger shows model R')
    await models.open()
    const selected = await until(async () => {
      const rows = (await models.thinkingLevels()).filter((r) => r.selected)
      return rows.length === 1 && rows[0].level === 'xhigh' ? rows : null
    }, 'welcome thinking picker seeded with xhigh')
    expect(selected.map((r) => r.level)).toEqual(['xhigh'])
    await models.close()

    // ── 不碰选择器，直接发送：恰好建出一条新会话，这一轮跑完 ──
    const idsBefore = await listSessionIds(main)
    const since = await recorder.mark()
    const added = await newSessionsAfter(main, () => chat.typeAndSend(E3_TEXT))
    expect(added).toHaveLength(1)
    const sid = added[0]
    await recorder.waitFor('agent_end', { sessionId: sid, since })
    await chat.waitIdle()
    const idsAfter = await listSessionIds(main)
    expect(idsAfter.filter((id) => !idsBefore.includes(id))).toEqual([sid])

    // ── IPC：种下的默认档不是选择 —— 会话不存档位；后端回落（R 声明了推理 → 设置里的 xhigh）：
    //    init 报 xhigh、agent 实际用 xhigh ──
    expect(await sessionSettings(sid)).not.toHaveProperty('thinkingLevel')
    expect((await init(sid)).modelMetadata.thinkingLevel).toBe('xhigh')
    expect((await runtimeInfo(sid))?.thinkingLevel).toBe('xhigh')

    // ── 重新打开设置页：仍选中 xhigh ──
    settings = await live().openSettings('general')
    const after = defaultThinkingPane(settings)
    await after.ready()
    await until(
      async () => (await after.selectedIndex()) === level('xhigh'),
      'settings row shows xhigh after the restart'
    )
  })

  it('DT-E-4 再重启：欢迎页种 xhigh，只把模型换成不推理的 N、不碰档位就发送 → 新会话不存档位，init 与 agent 都回落到 off', async () => {
    expect(await storedDefault()).toBe('xhigh')

    const main = await restart()
    const recorder = eventRecorder(main)
    await recorder.install()
    const chat = chatPane(main)
    const models = modelPickerPane(main)

    // ── 欢迎页：默认模型 R、种的是 xhigh ──
    await chat.ready()
    await until(async () => (await models.currentModel()) === MODEL_R, 'trigger shows model R')
    await models.open()
    await until(async () => {
      const rows = (await models.thinkingLevels()).filter((r) => r.selected)
      return rows.length === 1 && rows[0].level === 'xhigh'
    }, 'welcome thinking picker seeded with xhigh')

    // ── 只换模型：N；档位一行不碰，换完仍是 xhigh ──
    expect(await models.pick(MODEL_N)).toBe(true)
    await until(async () => (await models.currentModel()) === MODEL_N, 'trigger shows model N')
    await models.open()
    const selected = (await models.thinkingLevels()).filter((r) => r.selected)
    expect(selected.map((r) => r.level)).toEqual(['xhigh'])
    await models.close()

    // ── 直接发送：恰好建出一条新会话，这一轮跑完 ──
    const idsBefore = await listSessionIds(main)
    const since = await recorder.mark()
    const added = await newSessionsAfter(main, () => chat.typeAndSend(E4_TEXT))
    expect(added).toHaveLength(1)
    const sid = added[0]
    await recorder.waitFor('agent_end', { sessionId: sid, since })
    await chat.waitIdle()
    const idsAfter = await listSessionIds(main)
    expect(idsAfter.filter((id) => !idsBefore.includes(id))).toEqual([sid])

    // ── IPC：会话不存档位；N 没声明推理 → 后端回落 off（不吃设置里的 xhigh）──
    expect(await sessionSettings(sid)).not.toHaveProperty('thinkingLevel')
    const info = await init(sid)
    expect(info.model).toBe(MODEL_N)
    expect(info.modelMetadata.thinkingLevel).toBe('off')
    const runtime = await runtimeInfo(sid)
    expect(runtime?.model.id).toBe(MODEL_N)
    expect(runtime?.thinkingLevel).toBe('off')
  })
})
