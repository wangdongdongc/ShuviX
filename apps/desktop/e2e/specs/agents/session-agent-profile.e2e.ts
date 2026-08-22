/**
 * 会话 agent 档案的后端语义：`session.listAgentProfiles` 列出可切档案（含切回用的
 * default，不含 notebook 基座）、切换粘性生效并重建根 Agent（systemPrompt + 内置工具
 * 白名单随之更换）、未知/基座档案拒绝、档案被删回落；外加切换时的**种子**语义 ——
 * 档案声明的 `shuvix-model` 与 mcp:/skill: 工具在切换那一刻写进会话树一次，
 * 之后会话树仍是模型/工具的唯一事实源。
 *
 * （档案切换曾经是 `/<agentName>` 斜杠命令，已改由输入框的档案选择器承担；
 * 这里顺带钉住命令源里不再有 agent 项。）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createAgentSession,
  seedCustomProvider,
  seedEnabledModel,
  seedSkill,
  writeAgentMd
} from '../../harness/seed'

let app: E2EApp
/** 自定义提供商 id（uuidv7，beforeAll 里现造）—— slashmodelprofile 的前缀 */
let customProviderId: string

/** 合成模型 id：避免与启动时从 pi-ai 同步进来的真实模型重名 */
const MODEL_A = 'e2e-model-a'
const MODEL_B = 'e2e-model-b'
const SLASH_MODEL = 'vendor/e2e-slash-model'
/** 种在 fake HOME 的全局 skill 名（skillprofile 的 shuvix-tools 引用它） */
const SEED_SKILL = 'e2e-seed-skill'

beforeAll(async () => {
  app = await launchApp()
  writeAgentMd(app, 'e2eprofile', {
    description: 'e2e 档案切换',
    tools: 'read',
    body: 'E2E PROFILE BODY.'
  })

  // 模型目录：内置提供商种子数据是 isEnabled=0，不启用则任何 shuvix-model 都解析不出来
  await seedEnabledModel(app.main, { providerId: 'openai', modelId: MODEL_A })
  await seedEnabledModel(app.main, { providerId: 'openai', modelId: MODEL_B })
  customProviderId = await seedCustomProvider(app.main, { name: 'e2e-custom-vendor' })
  await app.main.eval(
    `window.api.provider.addModel({ providerId: ${JSON.stringify(customProviderId)}, modelId: ${JSON.stringify(SLASH_MODEL)} })`
  )

  writeAgentMd(app, 'modelprofile', {
    description: '声明可用模型',
    tools: 'read',
    model: `openai/${MODEL_A}`,
    body: 'MODEL PROFILE BODY.'
  })
  writeAgentMd(app, 'baremodelprofile', {
    description: '裸模型 id',
    tools: 'read',
    model: MODEL_B,
    body: 'BARE MODEL PROFILE BODY.'
  })
  writeAgentMd(app, 'slashmodelprofile', {
    description: 'uuid 提供商 + 模型 id 自带斜杠',
    tools: 'read',
    model: `${customProviderId}/${SLASH_MODEL}`,
    body: 'SLASH MODEL PROFILE BODY.'
  })
  // 真实可用的 skill —— 否则 filterAvailableTools 会把种进会话树的名字剔掉
  seedSkill(app, SEED_SKILL)
  writeAgentMd(app, 'skillprofile', {
    description: '声明 skill 工具',
    tools: `read, skill:${SEED_SKILL}`,
    body: 'SKILL PROFILE BODY.'
  })
  writeAgentMd(app, 'badmodelprofile', {
    description: '声明当前不可用的模型',
    tools: 'read',
    model: 'openai/nope-not-there',
    body: 'BAD MODEL PROFILE BODY.'
  })
})
afterAll(async () => {
  await app.stop()
})

interface SlashCommand {
  commandId: string
  kind?: 'project' | 'skill'
}

interface AppliedModel {
  provider: string
  model: string
  capabilities: Record<string, unknown>
}

interface ProfileSummary {
  name: string
  displayName: string
  description: string
  source: 'builtin' | 'user'
  model?: string
}

const listCommands = (sid: string | null): Promise<SlashCommand[]> =>
  app.main.eval(`window.api.command.list({ sessionId: ${JSON.stringify(sid)} })`)

const listProfiles = (): Promise<ProfileSummary[]> =>
  app.main.eval('window.api.session.listAgentProfiles()')

const setProfile = (
  sid: string,
  name: string
): Promise<{
  success: boolean
  error?: string
  applied?: { model?: AppliedModel; tools: string[] }
  modelUnavailable?: string
}> =>
  app.main.eval(
    `window.api.session.updateAgentProfile({ id: ${JSON.stringify(sid)}, name: ${JSON.stringify(name)} })`
  )

/** 重建后的运行时快照（getInfo ensure=true 走懒创建，不请求 LLM） */
const runtimeInfo = (
  sid: string
): Promise<{
  systemPrompt: string
  tools: { name: string }[]
  model: { provider: string; id: string }
}> => app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`)

/** 会话树解析出的运行配置（init 不创建运行时）—— 「种子有没有落到树上」的接缝 */
const treeModel = (sid: string): Promise<{ provider: string; model: string }> =>
  app.main.eval(
    `window.api.agent.init({ sessionId: ${JSON.stringify(sid)} })
      .then((r) => ({ provider: r.provider, model: r.model }))`
  )

/**
 * 用户手动切模型（与模型选择器同一条 IPC），**等到写入在会话树上可见**才返回。
 *
 * `agent:setModel` 的 handler 丢掉 gateway 的 Promise 后立刻返回 `{success:true}`
 * （`src/main/ipc/agentHandlers.ts` 的 `ipcMain.handle('agent:setModel', …)`）——
 * await 它并不保证 model_change 已经落到树上。本组用例里手动切模型只是**前置条件**，
 * 所以在这里等它落定；被测的档案种子写入（`session:updateAgentProfile`）本身是
 * await 的，下面所有断言都不做任何等待。
 */
const setModel = async (sid: string, provider: string, model: string): Promise<void> => {
  await app.main.eval(
    `window.api.agent.setModel({ sessionId: ${JSON.stringify(sid)}, provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(model)} })`
  )
  await until(async () => {
    const cur = await treeModel(sid)
    return cur.provider === provider && cur.model === model
  }, `会话模型写入可见 ${provider}/${model}`)
}

const toggleProvider = (id: string, isEnabled: boolean): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.provider.toggleEnabled({ id: ${JSON.stringify(id)}, isEnabled: ${isEnabled} })`
  )

describe('可切换档案列表', () => {
  it('列出内置 + 用户档案，含切回基座用的 default', async () => {
    const names = (await listProfiles()).map((p) => p.name)
    expect(names).toContain('default')
    expect(names).toContain('e2eprofile')
    expect(names).toContain('wiki')
  })

  it('不列 notebook —— 它是笔记本会话形态的基座，不是可切换目标', async () => {
    expect((await listProfiles()).map((p) => p.name)).not.toContain('notebook')
  })

  it('带上选择器要显示的字段：displayName / description / source / 声明的模型', async () => {
    const profiles = await listProfiles()
    const userProfile = profiles.find((p) => p.name === 'modelprofile')!
    expect(userProfile).toMatchObject({
      displayName: 'modelprofile',
      description: '声明可用模型',
      source: 'user',
      model: `openai/${MODEL_A}`
    })
    expect(profiles.find((p) => p.name === 'wiki')?.source).toBe('builtin')
    // systemPrompt 刻意不进列表（内置档案各是一整页提示词，选择器用不上）
    expect(userProfile).not.toHaveProperty('systemPrompt')
  })

  it('斜杠命令源里不再有 agent 项（该入口已改为档案选择器）', async () => {
    const { sid } = await createAgentSession(app.main)
    expect((await listCommands(sid)).filter((c) => c.kind === undefined)).toBeDefined()
    expect((await listCommands(sid)).some((c) => c.commandId === 'e2eprofile')).toBe(false)
  })
})

describe('会话档案切换', () => {
  it('切到具名档案：systemPrompt 换成该档案 body，内置工具收窄到其白名单', async () => {
    const { sid, systemPrompt: before } = await createAgentSession(app.main)
    expect(before.startsWith('E2E PROFILE BODY.')).toBe(false)

    expect(await setProfile(sid, 'e2eprofile')).toMatchObject({ success: true })

    const after = await runtimeInfo(sid)
    expect(after.systemPrompt.startsWith('E2E PROFILE BODY.')).toBe(true)
    // shuvix-tools: read —— 内置工具收窄到白名单（SkillTool 由装配固定附加，不受白名单管辖）
    const names = after.tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('write')
  })

  it('粘性：档案存进会话设置，重建后仍是它', async () => {
    const { sid } = await createAgentSession(app.main)
    await setProfile(sid, 'e2eprofile')
    const settings = await app.main.eval<{ agentProfile?: string }>(
      `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s.settings)`
    )
    expect(settings.agentProfile).toBe('e2eprofile')
    expect((await runtimeInfo(sid)).systemPrompt.startsWith('E2E PROFILE BODY.')).toBe(true)
  })

  it('切回 default：systemPrompt 回到基座档案', async () => {
    const { sid } = await createAgentSession(app.main)
    await setProfile(sid, 'e2eprofile')
    expect((await runtimeInfo(sid)).systemPrompt.startsWith('E2E PROFILE BODY.')).toBe(true)

    expect(await setProfile(sid, 'default')).toMatchObject({ success: true })
    expect((await runtimeInfo(sid)).systemPrompt.startsWith('E2E PROFILE BODY.')).toBe(false)
  })

  it('未知档案：拒绝且不改会话设置', async () => {
    const { sid } = await createAgentSession(app.main)
    const res = await setProfile(sid, 'nope-does-not-exist')
    expect(res.success).toBe(false)
    expect(res.error).toContain('nope-does-not-exist')
    const settings = await app.main.eval<{ agentProfile?: string }>(
      `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s.settings)`
    )
    expect(settings.agentProfile).toBeUndefined()
  })

  it('拒绝切到 notebook 基座档案（档案存在，但不是切换目标）', async () => {
    const { sid } = await createAgentSession(app.main)
    const res = await setProfile(sid, 'notebook')
    expect(res.success).toBe(false)
    expect(res.error).toContain('base profile')
    const settings = await app.main.eval<{ agentProfile?: string }>(
      `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s.settings)`
    )
    expect(settings.agentProfile).toBeUndefined()
  })

  it('档案文件被删：会话回落 default 而非卡死', async () => {
    const { sid } = await createAgentSession(app.main)
    await setProfile(sid, 'e2eprofile')
    expect((await runtimeInfo(sid)).systemPrompt.startsWith('E2E PROFILE BODY.')).toBe(true)

    await app.main.eval(`window.api.subAgent.delete({ name: 'e2eprofile' })`)
    // 失效重建（删档案不会自动 invalidate）—— 下一次创建按回落解析
    await app.main.eval(`window.api.message.clear(${JSON.stringify(sid)})`)
    expect((await runtimeInfo(sid)).systemPrompt.startsWith('E2E PROFILE BODY.')).toBe(false)

    writeAgentMd(app, 'e2eprofile', { tools: 'read', body: 'E2E PROFILE BODY.' })
  })
})

describe('档案模型种子（shuvix-model）', () => {
  it('切到声明了可用模型的档案：applied 回传解析结果，且种子落进会话树', async () => {
    const { sid } = await createAgentSession(app.main)
    const res = await setProfile(sid, 'modelprofile')

    expect(res.success).toBe(true)
    expect(res.applied?.model?.provider).toBe('openai')
    expect(res.applied?.model?.model).toBe(MODEL_A)
    expect(typeof res.applied?.model?.capabilities).toBe('object')
    expect(await treeModel(sid)).toEqual({ provider: 'openai', model: MODEL_A })
  })

  it('重建后的运行时确实用它', async () => {
    const { sid } = await createAgentSession(app.main)
    await setProfile(sid, 'modelprofile')

    const { model } = await runtimeInfo(sid)
    expect(model.provider).toBe('openai')
    expect(model.id).toBe(MODEL_A)
  })

  it('种子只在切换那一刻：之后手选的模型不会被档案还原', async () => {
    const { sid } = await createAgentSession(app.main)
    await setProfile(sid, 'modelprofile')
    await setModel(sid, 'openai', MODEL_B)

    // 保留会话树的失效重建（message.clear 会连 model_change 一起删掉，测不到想测的东西）
    await app.main.eval(
      `window.api.session.updateInstructionFile({ id: ${JSON.stringify(sid)}, filename: null })`
    )

    expect(await treeModel(sid)).toEqual({ provider: 'openai', model: MODEL_B })
    expect((await runtimeInfo(sid)).model.id).toBe(MODEL_B)
  })

  it('档案未声明模型（用户档案 / 内置 wiki）：无 applied，会话模型分毫不动', async () => {
    const { sid } = await createAgentSession(app.main)
    await setModel(sid, 'openai', MODEL_B)
    const before = await treeModel(sid)

    for (const name of ['e2eprofile', 'wiki']) {
      const res = await setProfile(sid, name)
      expect(res.success).toBe(true)
      expect(res.applied?.model).toBeUndefined()
      expect(await treeModel(sid)).toEqual(before)
    }
  })

  it('声明的模型当前不可用：不阻断切档案（档案照常生效），只是不写种子', async () => {
    const { sid } = await createAgentSession(app.main)
    await setModel(sid, 'openai', MODEL_B)
    const before = await treeModel(sid)

    const res = await setProfile(sid, 'badmodelprofile')
    expect(res.success).toBe(true)
    expect(res.applied?.model).toBeUndefined()
    expect(await treeModel(sid)).toEqual(before)
    // 模型不可用不影响档案本身生效
    expect((await runtimeInfo(sid)).systemPrompt.startsWith('BAD MODEL PROFILE BODY.')).toBe(true)
  })

  it('提供商被停用后档案模型即不可用（只取已启用提供商的已启用模型）', async () => {
    const { sid } = await createAgentSession(app.main)
    expect((await setProfile(sid, 'modelprofile')).applied?.model?.model).toBe(MODEL_A)

    await toggleProvider('openai', false)
    try {
      const res = await setProfile(sid, 'modelprofile')
      expect(res.success).toBe(true)
      expect(res.applied?.model).toBeUndefined()
      // 保持上一次的值，不因解析失败而回落默认
      expect(await treeModel(sid)).toEqual({ provider: 'openai', model: MODEL_A })
    } finally {
      await toggleProvider('openai', true)
    }
  })

  it('裸模型 id 也能解析：provider 由模型目录回填', async () => {
    const { sid } = await createAgentSession(app.main)
    const res = await setProfile(sid, 'baremodelprofile')

    expect(res.applied?.model?.provider).toBe('openai')
    expect(res.applied?.model?.model).toBe(MODEL_B)
  })

  it('uuid 提供商 + 模型 id 自带斜杠：按首个斜杠拆，前缀整段是 uuid', async () => {
    const { sid } = await createAgentSession(app.main)
    const res = await setProfile(sid, 'slashmodelprofile')

    expect(res.applied?.model?.provider).toBe(customProviderId)
    expect(res.applied?.model?.model).toBe(SLASH_MODEL)
    expect(await treeModel(sid)).toEqual({ provider: customProviderId, model: SLASH_MODEL })

    const { model } = await runtimeInfo(sid)
    expect(model.provider).toBe(customProviderId)
    expect(model.id).toBe(SLASH_MODEL)
  })

  it('重复切到同一个档案 = 再播一次种（切换即播种的现状语义）', async () => {
    const { sid } = await createAgentSession(app.main)
    await setProfile(sid, 'modelprofile')
    await setModel(sid, 'openai', MODEL_B)
    expect(await treeModel(sid)).toEqual({ provider: 'openai', model: MODEL_B })

    await setProfile(sid, 'modelprofile')
    expect(await treeModel(sid)).toEqual({ provider: 'openai', model: MODEL_A })
  })

  it('失败路径不写模型：未知档案 / notebook 基座都不动会话模型', async () => {
    const { sid } = await createAgentSession(app.main)
    await setModel(sid, 'openai', MODEL_B)
    const before = await treeModel(sid)

    for (const name of ['nope-does-not-exist', 'notebook']) {
      const res = await setProfile(sid, name)
      expect(res.success).toBe(false)
      expect(res.applied?.model).toBeUndefined()
      expect(await treeModel(sid)).toEqual(before)
    }
  })
})

/**
 * 工具种子：档案的 `shuvix-tools` 对内置 / mcp: / skill: 是一并声明的，切档案时
 * mcp:/skill: **替换**（不是叠加）会话勾选 —— 否则用户在工具选择器里取消勾选会被
 * 档案白名单并集加回来。内置工具不进勾选（恒由档案白名单决定）。
 */
describe('档案工具种子（shuvix-tools 的 mcp:/skill:）', () => {
  const treeTools = (sid: string): Promise<string[]> =>
    app.main.eval(
      `window.api.agent.init({ sessionId: ${JSON.stringify(sid)} }).then((r) => r.enabledTools)`
    )

  it('切档案：会话勾选被替换成档案声明的 mcp:/skill:，内置名不混进来', async () => {
    const { sid } = await createAgentSession(app.main)
    const res = await setProfile(sid, 'skillprofile')
    expect(res.applied?.tools).toEqual([`skill:${SEED_SKILL}`])
    expect(await treeTools(sid)).toEqual([`skill:${SEED_SKILL}`])
  })

  it('切到未声明 mcp:/skill: 的档案 = 清空勾选（档案是完整声明，不是增量）', async () => {
    const { sid } = await createAgentSession(app.main)
    await setProfile(sid, 'skillprofile')
    expect(await treeTools(sid)).toEqual([`skill:${SEED_SKILL}`])

    const res = await setProfile(sid, 'e2eprofile')
    expect(res.applied?.tools).toEqual([])
    expect(await treeTools(sid)).toEqual([])
  })

  it('种子之后用户仍能自行增删（勾选是会话的事实源，不被档案并集加回来）', async () => {
    const { sid } = await createAgentSession(app.main)
    await setProfile(sid, 'skillprofile')
    // 用户在工具选择器里取消勾选
    await app.main.eval(
      `window.api.agent.setEnabledTools({ sessionId: ${JSON.stringify(sid)}, tools: [] })`
    )
    expect(await treeTools(sid)).toEqual([])
    // 重建后的运行时里也确实没有它（档案白名单不再把它并回来）
    const info = await runtimeInfo(sid)
    expect(info.tools.map((t) => t.name)).not.toContain(`skill:${SEED_SKILL}`)
  })
})
