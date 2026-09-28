/**
 * 桌面派发工具（AgentTool.ts）的派发面注册表 —— 只由宿主派发的档案（HOST_ONLY_PROFILE_NAMES，
 * 今天是权限审查员 permission-reviewer）对 agent 而言**不存在**：
 *
 *  - AT-1 按名派发它 → 与查无此名同一句 `Unknown agent "…". Available: […]`，runTask 零次，
 *         连 agentService.getProfile 都不问（「按名也解析不到」，不是「解析到了再拒」）；
 *  - AT-2 两种错误（Unknown / Missing name）列出的可用名里没有它，也没有六个基座
 *         （BASE_PROFILE_NAMES 全体）；coding / explore / 用户自己的档案照列；
 *  - AT-3 用户按名覆盖了同名文件（注册表给出 source user 的那份）：照样拒、照样不列；
 *  - AT-4 对照：coding 照常派发；前后带空白的名字去空白后与 AT-1 同一句；
 *  - AT-5 路径形式的 ref（frontmatter name 恰是 permission-reviewer）今天**照样派发** —— 钉现状：
 *         这是已接受的残余（设计稿 §9：那份 md 是 agent 自己能写的内容，不是宿主的审查员，
 *         审查员的真身只从内置与 ~/.shuvix 解析，而写 ~/.shuvix/agents 被 protect-shuvix-config 挡在人面前）。
 *
 * 被审的 agent 要是能派发审查员，就能反复拿它试探「哪种写法能过审」—— 这组用例钉的就是那扇门关着。
 *
 * 替身：agentService（listAll / getProfile / loadAgentFromRef 都读一张可编程的档案表）、agentManager
 * （runTask 是 spy）、toolContext（TOOL_ABORTED + 固定工作目录）、toolRegistry（注册只记一笔）、i18n。
 * 派发工具本体（createDispatchAgentTool）与两张名单常量用 agent-runtime 的真件。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BASE_PROFILE_NAMES,
  PERMISSION_REVIEWER_PROFILE_NAME,
  type AgentProfile,
  type SubAgentModelConfig
} from '@shuvix/agent-runtime'
import type { ToolContext } from '../../services/toolContext'

const mocks = vi.hoisted(() => ({
  /** agentService 眼里的档案表（listAll 的结果；getProfile 在其中按名找） */
  profiles: [] as unknown[],
  getProfile: vi.fn<(name: string) => unknown>(),
  loadAgentFromRef: vi.fn<(path: string, baseDir?: string) => unknown>(),
  runTask: vi.fn<(params: Record<string, unknown>) => Promise<{ result: string }>>(),
  resolveProjectConfig: vi.fn<(sessionId: string) => { workingDirectory: string }>(),
  registerBuiltinTool: vi.fn()
}))

vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../services/toolContext', () => ({
  TOOL_ABORTED: 'Aborted',
  resolveProjectConfig: mocks.resolveProjectConfig
}))
vi.mock('../../services/agentService', () => ({
  agentService: {
    listAll: () => mocks.profiles,
    getProfile: mocks.getProfile,
    loadAgentFromRef: mocks.loadAgentFromRef
  }
}))
vi.mock('../AgentManager', () => ({ agentManager: { runTask: mocks.runTask } }))
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: mocks.registerBuiltinTool }))

import { createAgentTool } from '../AgentTool'

const SELF = 'sess-dispatch-self'
const ROOT = 'sess-dispatch-root'
const MODEL: SubAgentModelConfig = { provider: 'p', model: 'm', capabilities: {} }

/** 一份档案（派发只读投影需要的那几项） */
function profileOf(name: string, source: 'builtin' | 'user' = 'builtin'): AgentProfile {
  return {
    name,
    displayName: name,
    description: `${name} agent`,
    systemPrompt: `${name} prompt`,
    tools: ['read'],
    instructionFiles: [],
    projectAwareness: false,
    source,
    basePath: source === 'user' ? `/home/u/.shuvix/agents/${name}.md` : ''
  }
}

/** 内置全集（六个基座取真常量，外加具名 agent 与审查员）+ 一份用户自己的档案 */
function defaultProfiles(): AgentProfile[] {
  return [
    ...[...BASE_PROFILE_NAMES].map((name) => profileOf(name)),
    ...['coding', 'explore', 'widget', 'titler', 'knowledge-writer'].map((name) => profileOf(name)),
    profileOf(PERMISSION_REVIEWER_PROFILE_NAME),
    profileOf('my-helper', 'user')
  ]
}

/** 用户按名覆盖了审查员：注册表里生效的是 source user 的那一份（内置那份被遮蔽） */
function overriddenProfiles(): AgentProfile[] {
  return defaultProfiles().map((p) =>
    p.name === PERMISSION_REVIEWER_PROFILE_NAME ? profileOf(p.name, 'user') : p
  )
}

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset()
  mocks.profiles = defaultProfiles()
  mocks.getProfile.mockImplementation((name) =>
    (mocks.profiles as AgentProfile[]).find((p) => p.name === name)
  )
  mocks.runTask.mockResolvedValue({ result: 'done' })
  mocks.resolveProjectConfig.mockReturnValue({ workingDirectory: '/w' })
})

/** 造一个派发工具，派发一次，交回结果文本 */
async function dispatch(params: { name?: string; prompt?: string }): Promise<string> {
  const tool = createAgentTool({ sessionId: SELF } as ToolContext, {
    modelConfig: MODEL,
    rootSessionId: ROOT
  })
  const result = await tool.execute('tc-dispatch', {
    description: 'do a thing',
    prompt: params.prompt ?? 'the task',
    ...(params.name !== undefined ? { name: params.name } : {})
  })
  const first = result.content[0] as { type: string; text: string }
  expect(first.type).toBe('text')
  return first.text
}

/** 错误文本里 `Available: [a, b]` 那一截 */
function availableOf(text: string): string[] {
  const match = /Available: \[([^\]]*)\]/.exec(text)
  expect(match, text).not.toBeNull()
  return match![1] ? match![1].split(', ') : []
}

/** 可用名单的共同断言：审查员与六个基座都不在，coding / explore / 用户档案都在 */
function expectDispatchableOnly(names: string[]): void {
  expect(names).not.toContain(PERMISSION_REVIEWER_PROFILE_NAME)
  for (const base of BASE_PROFILE_NAMES) expect(names, base).not.toContain(base)
  expect(names).toEqual(
    expect.arrayContaining(['coding', 'explore', 'widget', 'titler', 'knowledge-writer'])
  )
  expect(names).toContain('my-helper')
}

describe('派发工具：只由宿主派发的档案对 agent 不存在', () => {
  it('AT-1 name 为 permission-reviewer → 与查无此名同一句 Unknown agent，runTask 零次，连 getProfile 都不问', async () => {
    const text = await dispatch({ name: PERMISSION_REVIEWER_PROFILE_NAME })

    expect(
      text.startsWith(`Unknown agent "${PERMISSION_REVIEWER_PROFILE_NAME}". Available: [`)
    ).toBe(true)
    // 与真正查无此名的那一句逐字同形：不给模型「这个名字其实存在，换条路再试」的线索
    const ghost = await dispatch({ name: 'ghost-agent' })
    expect(text).toBe(ghost.replace('"ghost-agent"', `"${PERMISSION_REVIEWER_PROFILE_NAME}"`))

    expect(mocks.runTask).not.toHaveBeenCalled()
    // 「按名也解析不到」：审查员这个名字根本没问到注册表（ghost-agent 那次问了）
    expect(mocks.getProfile.mock.calls).toEqual([['ghost-agent']])
  })

  it('AT-2 两种错误（Unknown / Missing name）列出的可用名里没有审查员与六个基座；coding / explore / 用户档案照列', async () => {
    const unknown = await dispatch({ name: PERMISSION_REVIEWER_PROFILE_NAME })
    const missing = await dispatch({})
    const blank = await dispatch({ name: '   ' })

    expect(missing.startsWith('Missing "name"')).toBe(true)
    expect(blank).toBe(missing)
    for (const text of [unknown, missing]) expectDispatchableOnly(availableOf(text))
    // 两处列的是同一份名单
    expect(availableOf(missing)).toEqual(availableOf(unknown))
    expect(mocks.runTask).not.toHaveBeenCalled()
  })

  it('AT-3 用户按名覆盖了 permission-reviewer.md（注册表给出 source user 的那份）：照样拒、照样不列', async () => {
    mocks.profiles = overriddenProfiles()
    expect(mocks.getProfile(PERMISSION_REVIEWER_PROFILE_NAME)).toMatchObject({ source: 'user' })
    mocks.getProfile.mockClear()

    const unknown = await dispatch({ name: PERMISSION_REVIEWER_PROFILE_NAME })
    const missing = await dispatch({})

    expect(
      unknown.startsWith(`Unknown agent "${PERMISSION_REVIEWER_PROFILE_NAME}". Available: [`)
    ).toBe(true)
    for (const text of [unknown, missing]) expectDispatchableOnly(availableOf(text))
    expect(mocks.getProfile).not.toHaveBeenCalled()
    expect(mocks.runTask).not.toHaveBeenCalled()
  })

  it('AT-4 对照：coding 照常派发（runTask 恰一次，带着这次的派发参数）；前后带空白的 permission-reviewer 去空白后与 AT-1 同一句', async () => {
    const ok = await dispatch({ name: 'coding', prompt: 'fix the bug' })
    expect(ok).toBe('done')
    expect(mocks.runTask).toHaveBeenCalledTimes(1)
    expect(mocks.runTask.mock.calls[0][0]).toMatchObject({
      parentSessionId: SELF,
      parentToolCallId: 'tc-dispatch',
      agentType: expect.objectContaining({ name: 'coding' }),
      prompt: 'fix the bug',
      description: 'do a thing',
      modelConfig: MODEL
    })

    mocks.runTask.mockClear()
    const exact = await dispatch({ name: PERMISSION_REVIEWER_PROFILE_NAME })
    const padded = await dispatch({ name: `  ${PERMISSION_REVIEWER_PROFILE_NAME}  ` })
    expect(padded).toBe(exact)
    expect(mocks.runTask).not.toHaveBeenCalled()
  })

  it('AT-5 路径形式 ./reviewer.md（frontmatter name 恰是 permission-reviewer）今天照样派发 —— 钉现状：已接受的残余（那份 md 是 agent 自己写得出的内容，不是宿主的审查员）', async () => {
    mocks.loadAgentFromRef.mockReturnValue(profileOf(PERMISSION_REVIEWER_PROFILE_NAME, 'user'))

    const text = await dispatch({ name: './reviewer.md' })

    // 路径 ref 走 resolveAgentFile（按根会话的工作目录解析），不经派发面注册表 —— 名单常量在这条路上不起作用
    expect(mocks.loadAgentFromRef.mock.calls).toEqual([['./reviewer.md', '/w']])
    expect(mocks.resolveProjectConfig).toHaveBeenCalledWith(ROOT)
    expect(mocks.getProfile).not.toHaveBeenCalled()
    expect(text).toBe('done')
    expect(mocks.runTask).toHaveBeenCalledTimes(1)
    expect(mocks.runTask.mock.calls[0][0]).toMatchObject({
      agentType: expect.objectContaining({ name: PERMISSION_REVIEWER_PROFILE_NAME })
    })
  })
})
