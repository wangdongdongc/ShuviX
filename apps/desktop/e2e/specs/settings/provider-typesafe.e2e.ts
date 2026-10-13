/**
 * 内置提供商 TypeSafe —— 只提供分类模型（pi-ai 的 `typesafe`：`jev-latest`，`type: 'classifier'`）。
 * 它没有对话模型：启动同步不给它写模型行，所以它不进会话的模型选择；启用后它的 Jev 进「分类模型」清单
 * （`provider.listClassifierModels`）。设置页给它挂「分类器」标签、把模型管理换成一句提示。
 *
 *   E-TS-1 全新实例：恰一行 typesafe（id typesafe、TypeSafe、内置、停用）；启动同步给 openrouter 写了模型行，
 *          却一行都没给 typesafe；分类模型清单里没有它
 *   E-TS-2 不填 key 直接启用 → 分类模型清单出现 typesafe:jev-latest（挂在 typesafe 行下、名字 TypeSafe）；
 *          对话模型清单里没有它、它仍然没有模型行；停用 → 从清单里消失
 *   E-TS-3 设置 → 提供商：TypeSafe 行挂标签；选中 → 标题旁也挂、模型管理是点名 TypeSafe 的提示，没有同步钮
 *          与添加模型的输入框，API Key 输入框照旧在；openrouter 行与详情这些都没有（照常的模型管理）
 *   E-TS-4 启用后真重启（同一个 HOME）→ 仍恰一行 typesafe（种子不重复插），启用状态保留，清单里仍有 Jev
 *
 * **不发真请求**：每次启动都带 PROVIDER_KEY_ENV（各家 key 的环境变量置空，含 TYPESAFE_API_KEY）。
 * DOM 只经 pages.ts 的 providerSettingsPane；界面语言钉成 en。用例按顺序接力。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { listTargets, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { providerSettingsPane, type ProviderDetailState } from '../../harness/pages'
import { PROVIDER_KEY_ENV } from '../../harness/providerEnv'
import { waitRendererReady } from '../../harness/seed'

const S = en.settings
const TS = 'typesafe'
const JEV_ENTRY = {
  id: 'typesafe:jev-latest',
  providerId: TS,
  modelId: 'jev-latest',
  providerName: 'TypeSafe'
}

interface ProviderRow {
  id: string
  name: string
  displayName?: string
  isBuiltin: number | boolean
  isEnabled: number | boolean
}

interface ModelEntry {
  id: string
  providerId: string
  modelId: string
  providerName?: string
}

let app: E2EApp | undefined
let settings: CdpClient | undefined
/** 内置 openrouter 行的 id（新库可能是 uuid，所以从 listAll 现查） */
let openrouterId = ''

const live = (): E2EApp => {
  if (!app) throw new Error('app not running')
  return app
}

const listAll = (): Promise<ProviderRow[]> =>
  live().main.eval<ProviderRow[]>('window.api.provider.listAll()')
const listModels = (id: string): Promise<ModelEntry[]> =>
  live().main.eval<ModelEntry[]>(`window.api.provider.listModels(${JSON.stringify(id)})`)
const classifierModels = (): Promise<ModelEntry[]> =>
  live().main.eval<ModelEntry[]>('window.api.provider.listClassifierModels()')
const availableModels = (): Promise<ModelEntry[]> =>
  live().main.eval<ModelEntry[]>('window.api.provider.listAvailableModels()')
const setTypeSafeEnabled = (isEnabled: boolean): Promise<unknown> =>
  live().main.eval(`window.api.provider.toggleEnabled(${JSON.stringify({ id: TS, isEnabled })})`)

const hasJev = (list: ModelEntry[]): boolean =>
  list.some((m) => m.providerId === TS && m.modelId === 'jev-latest')

async function boot(home?: string): Promise<void> {
  app = await launchApp({ ...(home ? { home } : {}), env: PROVIDER_KEY_ENV })
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
}

/** 毁掉设置窗口，等它从 /json 里消失 */
async function closeSettings(): Promise<void> {
  if (!settings) return
  await settings.eval('window.close()').catch(() => undefined)
  settings.close()
  settings = undefined
  await until(
    async () =>
      !(await listTargets(live().port)).some(
        (t) => t.type === 'page' && t.url.includes('#settings')
      ) || null,
    'settings window target gone from /json'
  )
}

/** 选中一家，等详情标题换成它 */
async function selectAndWait(
  pane: ReturnType<typeof providerSettingsPane>,
  id: string,
  title: string
): Promise<ProviderDetailState> {
  await pane.select(id)
  return pane.waitDetail((s) => s.title === title, `detail of ${title}`)
}

beforeAll(async () => {
  await boot()
  const row = (await listAll()).find((r) => r.isBuiltin && r.name === 'openrouter')
  if (!row) throw new Error('builtin provider row openrouter not seeded')
  openrouterId = row.id
}, 120_000)

afterAll(async () => {
  await closeSettings().catch(() => undefined)
  await app?.stop()
})

describe('内置提供商 TypeSafe（只提供分类模型）', () => {
  it('E-TS-1 全新实例：恰一行 typesafe（内置、停用）；启动同步没给它写模型行；分类模型清单里没有它', async () => {
    const rows = (await listAll()).filter((r) => r.name === TS)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: TS, displayName: 'TypeSafe' })
    expect(rows[0].isBuiltin).toBeTruthy()
    expect(rows[0].isEnabled).toBeFalsy()

    // 前提：启动同步确实跑过（openrouter 有模型行）
    expect((await listModels(openrouterId)).length).toBeGreaterThan(0)
    expect(await listModels(TS)).toEqual([])
    expect(hasJev(await classifierModels())).toBe(false)
  })

  it('E-TS-2 不填 key 启用 → 分类模型清单里有 typesafe:jev-latest；对话模型清单里没有它、仍无模型行；停用 → 消失', async () => {
    await setTypeSafeEnabled(true)
    const list = await until(async () => {
      const entries = await classifierModels()
      return hasJev(entries) ? entries : null
    }, 'typesafe Jev listed after enabling typesafe')
    expect(list.filter((m) => m.providerId === TS)).toEqual([expect.objectContaining(JEV_ENTRY)])

    expect((await availableModels()).filter((m) => m.providerId === TS)).toEqual([])
    expect(await listModels(TS)).toEqual([])

    await setTypeSafeEnabled(false)
    await until(async () => !hasJev(await classifierModels()), 'typesafe Jev gone after disabling')
  })

  it('E-TS-3 设置 → 提供商：TypeSafe 行与标题挂标签、模型管理是提示、没有同步与添加、API Key 照旧；openrouter 照常', async () => {
    settings = await live().openSettings('providers')
    const pane = providerSettingsPane(settings)

    expect(await pane.rowTag(TS)).toEqual({ text: S.classifierTag, title: S.classifierTagTitle })
    expect(await pane.rowTags(TS)).toBe(1)
    expect(await pane.rowTags(openrouterId)).toBe(0)

    const ts = await selectAndWait(pane, TS, 'TypeSafe')
    expect(ts.headerTags).toBe(1)
    expect(ts.hint).toBe(S.classifierOnlyProviderHint.replace('{{name}}', 'TypeSafe'))
    expect(ts.hint).toContain('TypeSafe')
    expect(ts.buttons).not.toContain(S.syncModels)
    expect(ts.inputs.map((i) => i.placeholder)).not.toContain(S.addModelPlaceholder)
    expect(ts.inputs).toContainEqual({
      type: 'password',
      placeholder: S.apiKeyPlaceholder.replace('{{name}}', 'TypeSafe')
    })

    const routerTitle =
      (await listAll()).find((r) => r.id === openrouterId)?.displayName || 'openrouter'
    const router = await selectAndWait(pane, openrouterId, routerTitle)
    expect(router.headerTags).toBe(0)
    expect(router.hint).toBeNull()
    expect(router.buttons).toContain(S.syncModels)
    expect(router.inputs.map((i) => i.placeholder)).toContain(S.addModelPlaceholder)

    await closeSettings()
  })

  it('E-TS-4 启用后真重启（同一个 HOME）→ 仍恰一行 typesafe、启用状态保留、清单里仍有 Jev', async () => {
    await setTypeSafeEnabled(true)
    await until(async () => hasJev(await classifierModels()), 'typesafe Jev listed before restart')

    const home = live().home
    await live().stop({ keepHome: true })
    app = undefined
    await boot(home)

    const rows = (await listAll()).filter((r) => r.name === TS)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(TS)
    expect(rows[0].isEnabled).toBeTruthy()
    expect(await listModels(TS)).toEqual([])
    await until(async () => hasJev(await classifierModels()), 'typesafe Jev listed after restart')
  })
})
