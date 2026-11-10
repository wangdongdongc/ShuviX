/**
 * 基座档案声明的模型 / 思考档位：一条会话自己没选过时，它的形态基座（无项目 → `chat`，项目 → `work`）md 里的
 * `shuvix-model` / `shuvix-thinking` 就是它的缺省，先于设置里的全局默认（2026-11-10 用户报告：新建会话不认
 * agent md 里配的模型，跑的总是全局默认）。
 *
 * 钉的是：
 *   - BP-1 覆盖了 `chat.md` 并声明模型 + 档位：新建的无项目会话，agent.init 给选择器的就是档案的模型与档位，
 *     真发一句，发给上游的 `model` 也是它；
 *   - BP-2 项目会话的基座 `work` 没被覆盖、没声明：照旧是全局默认；
 *   - BP-3 会话里选过模型（agent.setModel）：会话的选择赢，档案的模型不还原它；
 *   - BP-4 欢迎页（重启后落在这里，`chat.md` 已在）：输入框的模型选择器显示 `chat.md` 声明的模型（不是全局默认），
 *     不碰它直接发送 → 新建的会话、真发出去的请求都是它；种下的档位不是选择，会话不存档位，init 报档案的 low。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  newSessionsAfter,
  seedFakeProvider,
  waitRendererReady,
  writeAgentMd
} from '../../harness/seed'
import { until } from '../../harness/cdp'
import { chatPane, modelPickerPane } from '../../harness/pages'

/** 全局默认模型 */
const MODEL = 'e2e-model'
/** `chat.md` 声明的模型（同一个假提供商上的第二个模型） */
const MODEL_CHAT = 'e2e-model-chat'

interface InitResult {
  provider: string
  model: string
  modelMetadata: { thinkingLevel?: string }
}

let app: E2EApp
let provider: FakeProvider
let providerId = ''
let projectId = ''

const createSession = (projectIdOrNull: string | null): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ projectId: projectIdOrNull })}).then((s) => s.id)`
  )

const init = (sid: string): Promise<InitResult> =>
  app.main.eval(`window.api.agent.init({ sessionId: ${JSON.stringify(sid)} })`)

/** 真发一句，交回这一句发给上游时的 `model` */
async function modelSentFor(sid: string, text: string): Promise<string | undefined> {
  provider.script({ text: 'ok.', when: (r) => r.lastUserText === text })
  await app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )
  return provider.requests().find((r) => r.lastUserText === text)?.body.model
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  ;({ providerId } = await seedFakeProvider(app.main, {
    baseUrl: provider.baseUrl,
    modelId: MODEL
  }))
  await waitRendererReady(app.main)
  await app.main.eval(
    `window.api.provider.addModel(${JSON.stringify({ providerId, modelId: MODEL_CHAT })})`
  )
  writeAgentMd(app, 'chat', {
    description: '覆盖无项目会话的基座：声明模型与思考档位',
    tools: 'read',
    model: `${providerId}/${MODEL_CHAT}`,
    rawLines: ['shuvix-thinking: low'],
    body: 'CHAT OVERRIDE.'
  })
  const projDir = join(app.home, 'proj-base-model')
  mkdirSync(projDir, { recursive: true })
  ;({ id: projectId } = await createProject(app.main, { name: 'BaseModelProj', path: projDir }))
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('基座档案声明的模型 / 档位是会话没选过时的缺省', () => {
  it('BP-1 无项目新会话：用 chat.md 声明的模型与档位（选择器与真发出去的请求都是它）', async () => {
    const sid = await createSession(null)
    const cfg = await init(sid)
    expect([cfg.provider, cfg.model]).toEqual([providerId, MODEL_CHAT])
    expect(cfg.modelMetadata.thinkingLevel).toBe('low')
    expect(await modelSentFor(sid, 'BP-1 hello')).toBe(MODEL_CHAT)
  })

  it('BP-2 项目新会话：work 没声明 → 全局默认', async () => {
    const sid = await createSession(projectId)
    const cfg = await init(sid)
    expect([cfg.provider, cfg.model]).toEqual([providerId, MODEL])
    expect(await modelSentFor(sid, 'BP-2 hello')).toBe(MODEL)
  })

  it('BP-3 无项目会话里选过模型：会话的选择赢', async () => {
    const sid = await createSession(null)
    await app.main.eval(
      `window.api.agent.setModel(${JSON.stringify({ sessionId: sid, provider: providerId, model: MODEL })})`
    )
    const cfg = await init(sid)
    expect([cfg.provider, cfg.model]).toEqual([providerId, MODEL])
    expect(await modelSentFor(sid, 'BP-3 hello')).toBe(MODEL)
  })
})

describe('欢迎页：选择器显示、发送用的都是新会话会用的', () => {
  it('BP-4 重启落在欢迎页：选择器是 chat.md 的模型；不碰它直接发送 → 新会话与请求都用它，档位不存、init 报 low', async () => {
    // 真重启（同一个 HOME）：欢迎页在 chat.md 写好之后才种
    const home = app.home
    await app.stop({ keepHome: true })
    app = await launchApp({ home })
    await waitRendererReady(app.main)
    const main = app.main
    const recorder = eventRecorder(main)
    await recorder.install()
    const chat = chatPane(main)
    const models = modelPickerPane(main)

    await chat.ready()
    await until(
      async () => (await models.currentModel()) === MODEL_CHAT,
      'welcome picker shows the model chat.md declares'
    )

    const text = 'BP-4 hello from the welcome page'
    provider.script({ text: 'ok.', when: (r) => r.lastUserText === text })
    const since = await recorder.mark()
    const added = await newSessionsAfter(main, () => chat.typeAndSend(text))
    expect(added).toHaveLength(1)
    const sid = added[0]
    await recorder.waitFor('agent_end', { sessionId: sid, since })
    await chat.waitIdle()

    expect(provider.requests().find((r) => r.lastUserText === text)?.body.model).toBe(MODEL_CHAT)
    const cfg = await init(sid)
    expect([cfg.provider, cfg.model]).toEqual([providerId, MODEL_CHAT])
    expect(cfg.modelMetadata.thinkingLevel).toBe('low')
    const settings = await app.main.eval<Record<string, unknown>>(
      `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s.settings)`
    )
    expect(settings).not.toHaveProperty('thinkingLevel')
  })
})
