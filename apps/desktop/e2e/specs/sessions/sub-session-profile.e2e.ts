/**
 * `create-sub-session` 的 `agent_profile` —— 父级点名档案的全链路：
 * session 工具 → subSessionRunner.create → sessionService.pinAgentProfile（准入 / 落戳 / 档案
 * 声明的模型与 mcp:/skill: 种子）→ seedRunConfig（档案没意见的部分补回父级）。
 *
 * pinAgentProfile 没有 IPC 面，这条链只能像 sub-session.e2e 那样把模型换成脚本化的假提供商，
 * 让父会话真的调一次工具。每条用例脚本化一次 create-sub-session、按标题认领子会话；只 create
 * 不 prompt（每个父会话最多 20 条子会话，这里远够用）。
 *
 * 钉的是：
 *   - 点名 coding：戳落下、body 换成 coding、工具含 bash；
 *   - 点名用户档案：档案声明的模型压过父模型、mcp:/skill: **替换**父勾选、思考档位仍随父；
 *   - 点名只列内置工具的档案（coding）：父级的 skill 勾选补回来；
 *   - 点名基座 / 只可派发 / 未知名：创建照常成功、不落戳、body 是父形态的基座（项目 → work）；
 *   - 不点名：不落戳、基座 body、工具随父；
 *   - 档案声明了不可用的模型：戳落下、body 生效、模型等于父模型（不写种子、不回落默认）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  installAutoAllow,
  seedEnabledModel,
  seedFakeProvider,
  seedSkill,
  waitRendererReady,
  writeAgentMd
} from '../../harness/seed'

const MODEL = 'e2e-model'
/** 用户档案声明的模型（openai 目录里种一个合成 id，避免与同步进来的真实模型重名） */
const MODEL_A = 'e2e-model-a'
/** 父会话勾选的 skill / 档案声明的 skill —— 两个不同的名字，「替换」与「继承」才分得开 */
const SKILL_PARENT = 'e2e-skill-parent'
const SKILL_PROFILE = 'e2e-skill-profile'
const PARENT_TITLE = 'SP-parent'
/** work 基座独有的锚点；coding 正文里的一句 */
const WORK_ANCHOR = 'Handing work to a sub-session'
const CODING_ANCHOR = 'Only do what the user asked'

interface SessionRow {
  id: string
  title: string
  parentId: string | null
}

interface ListedMessage {
  blocks?: Array<{ type: string; toolName?: string; result?: string; isError?: boolean }>
}

interface InitResult {
  provider: string
  model: string
  enabledTools: string[]
  modelMetadata: { thinkingLevel?: string }
}

interface RuntimeInfo {
  systemPrompt: string
  tools: { name: string }[]
}

let app: E2EApp
let provider: FakeProvider
let parentSid = ''
/** 父会话此刻的整套运行配置（模型 / 思考档位 / 工具勾选）—— 种子的来源与对照 */
let parentCfg: InitResult
let callSeq = 0

const sessions = (): Promise<SessionRow[]> => app.main.eval(`window.api.session.list()`)

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const init = (sid: string): Promise<InitResult> =>
  app.main.eval(`window.api.agent.init({ sessionId: ${JSON.stringify(sid)} })`)

const runtimeInfo = (sid: string): Promise<RuntimeInfo> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`)

const settingsOf = (sid: string): Promise<Record<string, unknown>> =>
  app.main.eval(`window.api.session.getById(${JSON.stringify(sid)}).then((s) => s.settings)`)

const promptParent = (text: string): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(parentSid)}, text: ${JSON.stringify(text)} })`
  )

const byUserText =
  (text: string) =>
  (r: { lastUserText: string }): boolean =>
    r.lastUserText === text

/**
 * 让父会话的模型调一次 create-sub-session（可带 agent_profile），按标题认领建出的子会话，
 * 并交回父会话转写里那一块工具结果（带 id 的那块）。
 */
async function createSub(
  label: string,
  args: Record<string, unknown>
): Promise<{ id: string; result: string; isError: boolean }> {
  const title = `SP ${label}`
  const prompt = `开子会话 ${label}`
  provider.reset()
  provider.script(
    {
      toolCalls: [
        {
          id: `call_sp_${++callSeq}`,
          name: 'session',
          args: JSON.stringify({ action: 'create-sub-session', title, ...args })
        }
      ],
      when: byUserText(prompt)
    },
    { text: 'created.', when: byUserText(prompt) }
  )
  await promptParent(prompt)

  const row = (await sessions()).find((s) => s.title === title)
  expect(row, `sub-session "${title}" should exist`).toBeDefined()
  expect(row!.parentId).toBe(parentSid)
  const block = (await listMessages(parentSid))
    .flatMap((m) => (m.blocks ?? []).filter((b) => b.toolName === 'session'))
    .find((b) => (b.result ?? '').includes(row!.id))
  expect(block, 'tool result should carry the sub-session id').toBeDefined()
  return { id: row!.id, result: block!.result ?? '', isError: !!block!.isError }
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  // 档案模型解析只取已启用提供商的已启用模型：内置 openai 的种子数据是 isEnabled=0
  await seedEnabledModel(app.main, { providerId: 'openai', modelId: MODEL_A })
  // 真实可用的 skill —— 否则 filterAvailableTools 会把种进会话树的名字剔掉
  seedSkill(app, SKILL_PARENT)
  seedSkill(app, SKILL_PROFILE)
  writeAgentMd(app, 'e2e-sub-prof', {
    description: '声明模型与 skill 的档案',
    tools: `read, skill:${SKILL_PROFILE}`,
    model: `openai/${MODEL_A}`,
    body: 'SUB PROF BODY.'
  })
  writeAgentMd(app, 'e2e-badmodel', {
    description: '声明当前不可用的模型',
    tools: 'read',
    model: 'openai/nope-not-there',
    body: 'BAD MODEL BODY.'
  })

  const projDir = join(app.home, 'proj-sub-profile')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'SubProfProj', path: projDir })
  parentSid = await app.main.eval<string>(
    `window.api.session
      .create(${JSON.stringify({ title: PARENT_TITLE, projectId: project.id })})
      .then((s) => s.id)`
  )
  // 内置 ask-on-sub-session 对「开子会话」要问一句 —— 扮演那个点「允许一次」的用户
  await installAutoAllow(app.main)
  // 父会话勾选一个 skill：子会话「继承」与「替换」的对照物
  await app.main.eval(
    `window.api.agent.setEnabledTools({ sessionId: ${JSON.stringify(parentSid)}, tools: [${JSON.stringify(`skill:${SKILL_PARENT}`)}] })`
  )
  parentCfg = await init(parentSid)
  // 前置条件自检：父会话跑在假提供商上、勾着那一个 skill
  expect(parentCfg.model).toBe(MODEL)
  expect(parentCfg.enabledTools).toEqual([`skill:${SKILL_PARENT}`])
}, 60_000)

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('create-sub-session 的 agent_profile 钉档案', () => {
  it('SP-1 点名 coding：戳落下，body 换成 coding、工具含 bash，工具结果不报错且带子会话 id', async () => {
    const sub = await createSub('coding', { agent_profile: 'coding' })
    expect(sub.isError).toBe(false)
    expect(sub.result).toContain(sub.id)
    expect((await settingsOf(sub.id)).agentProfile).toBe('coding')

    const info = await runtimeInfo(sub.id)
    expect(info.systemPrompt).toContain(CODING_ANCHOR)
    expect(info.systemPrompt).not.toContain(WORK_ANCHOR)
    expect(info.tools.map((t) => t.name)).toContain('bash')
  })

  it('SP-2 点名用户档案：档案模型压过父模型，skill 勾选被**替换**成档案声明的那套，思考档位仍随父', async () => {
    const sub = await createSub('prof', { agent_profile: 'e2e-sub-prof' })
    const cfg = await init(sub.id)
    expect({ provider: cfg.provider, model: cfg.model }).toEqual({
      provider: 'openai',
      model: MODEL_A
    })
    // 替换语义：父会话勾的 SKILL_PARENT 没有被并进来
    expect(cfg.enabledTools).toEqual([`skill:${SKILL_PROFILE}`])
    // seedRunConfig 仍跑：思考档位没有档案声明这一路，恒随父
    expect(cfg.modelMetadata.thinkingLevel).toBe(parentCfg.modelMetadata.thinkingLevel)
    expect((await runtimeInfo(sub.id)).systemPrompt.startsWith('SUB PROF BODY.')).toBe(true)
  })

  it('SP-3 点名 coding（只列内置工具、不声明模型）：父级的 skill 勾选补回来，模型等于父模型', async () => {
    // 空的工具声明不算意见：pin 那一步把勾选清成 []，seedRunConfig 把父级那套铺回来 ——
    // 否则每条 coding 子会话都被摘掉项目的 MCP 与 skill
    const sub = await createSub('coding2', { agent_profile: 'coding' })
    const cfg = await init(sub.id)
    expect(cfg.enabledTools).toEqual(parentCfg.enabledTools)
    expect({ provider: cfg.provider, model: cfg.model }).toEqual({
      provider: parentCfg.provider,
      model: parentCfg.model
    })
  })

  it.each(['work', 'chat', 'notebook'])(
    'SP-4 点名基座 %s：创建不失败、不落戳，body 是父形态的基座（项目 → work）',
    async (base) => {
      // 子会话不点名就自然落到自己形态的基座上；点名一个基座只会得到说不清的组合，
      // 被拒之后会话已经建好且可用 —— 拒绝不该让整个创建失败
      const sub = await createSub(`base-${base}`, { agent_profile: base })
      expect(sub.isError).toBe(false)
      expect(sub.result).toContain(sub.id)
      expect('agentProfile' in (await settingsOf(sub.id))).toBe(false)
      expect((await runtimeInfo(sub.id)).systemPrompt).toContain(WORK_ANCHOR)
    }
  )

  it('SP-5 点名未知名：同 SP-4（不落戳、基座 body、创建成功）', async () => {
    const sub = await createSub('rejected-unknown', { agent_profile: 'nope-not-there' })
    expect(sub.isError).toBe(false)
    expect(sub.result).toContain(sub.id)
    expect('agentProfile' in (await settingsOf(sub.id))).toBe(false)
    expect((await runtimeInfo(sub.id)).systemPrompt).toContain(WORK_ANCHOR)
  })

  it('SP-5b 曾经只可派发的内置 wiki-writer 现在也钉得上 —— 会话感知这道门已退役', async () => {
    // 准入只剩「不是基座」：内置执行体、用户档案一视同仁。戳落下、body 换成它的、不再是父形态基座
    const sub = await createSub('writer', { agent_profile: 'wiki-writer' })
    expect(sub.isError).toBe(false)
    expect((await settingsOf(sub.id)).agentProfile).toBe('wiki-writer')
    expect((await runtimeInfo(sub.id)).systemPrompt).not.toContain(WORK_ANCHOR)
  })

  it('SP-6 不点名：不落戳、基座 body、工具勾选等于父会话的', async () => {
    const sub = await createSub('plain', {})
    expect('agentProfile' in (await settingsOf(sub.id))).toBe(false)
    expect((await runtimeInfo(sub.id)).systemPrompt).toContain(WORK_ANCHOR)
    expect((await init(sub.id)).enabledTools).toEqual(parentCfg.enabledTools)
  })

  it('SP-7 档案声明了不可用的模型：戳落下、body 生效，模型等于父模型（不写种子、不回落默认）', async () => {
    const sub = await createSub('badmodel', { agent_profile: 'e2e-badmodel' })
    expect((await settingsOf(sub.id)).agentProfile).toBe('e2e-badmodel')
    expect((await runtimeInfo(sub.id)).systemPrompt.startsWith('BAD MODEL BODY.')).toBe(true)
    const cfg = await init(sub.id)
    expect({ provider: cfg.provider, model: cfg.model }).toEqual({
      provider: parentCfg.provider,
      model: parentCfg.model
    })
  })
})
