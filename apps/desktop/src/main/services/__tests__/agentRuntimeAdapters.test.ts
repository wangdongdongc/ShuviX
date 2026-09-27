/**
 * electronEnv（agentRuntimeAdapters.ts，HG-4）—— 桌面端**不把 provider key 写进 process.env**。
 *
 * 为什么钉：buildSpawnEnv / 终端 / TTS 都展开 process.env，key 一旦写进去，每条 bash 命令、每个 stdio
 * MCP server、ssh 子进程都拿到用户所有 provider 的 key —— 命令沙箱放开网络之后，这就是一条现成的外泄
 * 路径。请求侧的 key 走 modelsAdapter 的 getApiKey 现取（那一面由 agent-runtime 的 modelsAdapter 单测
 * 覆盖），env 这条路在桌面端是空操作。
 *
 * 三层：直接调 setApiKey；经真实调用点 resolveModel（内置 provider 带 key 时它会调 env.setApiKey）；
 * 以及子进程环境 buildSpawnEnv 里找不到这把 key。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/shuvix-unit/user-data', isPackaged: false }
}))
vi.mock('../../frontend/core', () => ({
  chatFrontendRegistry: { broadcast: vi.fn(), hasCapability: vi.fn(() => false) }
}))
vi.mock('../notificationService', () => ({ notifyOnChatEvent: vi.fn() }))
vi.mock('../sessionDayPromptService', () => ({ recordFromUserMessageEvent: vi.fn() }))
vi.mock('../stepPersistPipeline', () => ({ transformToolResultForPersist: vi.fn() }))
vi.mock('../httpLogService', () => ({ httpLogService: { updateUsage: vi.fn() } }))
vi.mock('../chromeBridge', () => ({ observeChromeTabRun: vi.fn() }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { BUILTIN_ENV_MAP, resolveModel } from '@shuvix/agent-runtime'
import { electronEnv } from '../agentRuntimeAdapters'
import { buildSpawnEnv } from '../../utils/paths'

/** 本文件动到的所有 env 名（内置 provider 的全部映射）：用例前清掉、用例后原样还回去 */
const ENV_KEYS = [...new Set(Object.values(BUILTIN_ENV_MAP))]
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

describe('HG-4 electronEnv.setApiKey 是空操作 —— key 不进 process.env，也就不进子进程', () => {
  it('HG-4 setApiKey(OPENAI_API_KEY, sk-test)：process.env 里仍没有这个键；buildSpawnEnv() 里也没有', () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined()

    electronEnv.setApiKey('OPENAI_API_KEY', 'sk-test')

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect('OPENAI_API_KEY' in process.env).toBe(false)
    const spawnEnv = buildSpawnEnv()
    expect(spawnEnv).not.toHaveProperty('OPENAI_API_KEY')
    expect(Object.values(spawnEnv)).not.toContain('sk-test')
  })

  it('HG-4 用户自己在环境里设过的值原样保留（不覆盖、不删除）', () => {
    process.env.OPENAI_API_KEY = 'user-own-value'

    electronEnv.setApiKey('OPENAI_API_KEY', 'sk-test')

    expect(process.env.OPENAI_API_KEY).toBe('user-own-value')
    // 子进程拿到的是用户自己放进环境的那一份，不是 ShuviX 设置里的 key
    expect(buildSpawnEnv().OPENAI_API_KEY).toBe('user-own-value')
  })

  it('HG-4 每个内置 provider 的 env 名都一样：写完一轮，process.env 与 buildSpawnEnv 里一个都没有', () => {
    for (const key of ENV_KEYS) electronEnv.setApiKey(key, `sk-test-${key}`)

    const spawnEnv = buildSpawnEnv()
    for (const key of ENV_KEYS) {
      expect(process.env[key], key).toBeUndefined()
      expect(spawnEnv, key).not.toHaveProperty(key)
    }
    expect(Object.values(spawnEnv).some((v) => v?.startsWith('sk-test-'))).toBe(false)
  })

  it('HG-4 真实调用点：resolveModel 解析带 key 的内置 provider（会调 env.setApiKey）后，process.env 不变', () => {
    const setApiKey = vi.spyOn(electronEnv, 'setApiKey')
    try {
      const model = resolveModel({
        provider: 'openai',
        model: 'shuvix-unit-model',
        capabilities: {},
        providerInfo: { id: 'openai', name: 'openai', isBuiltin: true, apiKey: 'sk-test' },
        env: electronEnv
      })
      expect(model.provider).toBe('openai')
      // 调用点确实把 key 交给了宿主 —— 空操作的是宿主这一侧
      expect(setApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', 'sk-test')
    } finally {
      setApiKey.mockRestore()
    }

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(buildSpawnEnv()).not.toHaveProperty('OPENAI_API_KEY')
  })
})
