/**
 * electronEnv（agentRuntimeAdapters.ts，HG-4）—— 桌面端**不把 provider key 写进 process.env**。
 *
 * 为什么钉：buildSpawnEnv / 终端 / TTS 都展开 process.env，key 一旦写进去，每条 bash 命令、每个 stdio
 * MCP server、ssh 子进程都拿到用户所有 provider 的 key —— 命令沙箱放开网络之后，这就是一条现成的外泄
 * 路径。请求侧的 key 由 agent-runtime 模型层的 DB 凭据库每次请求现取（createModelRegistry →
 * createDbCredentialStore，那一面由 agent-runtime models/ 的单测覆盖），env 这条路在桌面端是空操作。
 *
 * 三层：直接调 setApiKey；经真实取 key 路径 createModelRegistry（内置 provider 的 DB key 解析成请求凭据）；
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

import { createModelRegistry, type ProviderRow } from '@shuvix/agent-runtime'
import { electronEnv } from '../agentRuntimeAdapters'
import { buildSpawnEnv } from '../../utils/paths'

/**
 * 本文件动到的所有 env 名（内置 provider 读的 key 变量）：用例前清掉、用例后原样还回去。
 * 以前取自 modelResolver 的 BUILTIN_ENV_MAP；模型层改走 DB 凭据库后那张表不复存在，这里留一份字面量。
 */
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'HF_TOKEN',
  'OPENCODE_API_KEY',
  'KIMI_API_KEY',
  'ZAI_API_KEY',
  'FIREWORKS_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'XIAOMI_API_KEY',
  'CLOUDFLARE_API_KEY'
]
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

  it('HG-4 真实取 key 路径：模型注册表把内置 provider 的 DB key 解析成请求凭据后，process.env 不变', async () => {
    const openaiRow: ProviderRow = {
      id: 'openai',
      name: 'openai',
      isBuiltin: true,
      isEnabled: true,
      apiKey: 'sk-test',
      baseUrl: '',
      apiProtocol: '',
      metadata: ''
    }
    const registry = createModelRegistry({
      port: {
        listProviders: () => [openaiRow],
        listModels: () => [],
        readOAuth: () => undefined,
        saveOAuth: () => {},
        clearOAuth: () => {}
      }
    })

    const auth = await registry.models.getAuth('openai')
    // key 确实交到了请求侧 —— 走的是凭据库，不是环境变量
    expect(auth?.auth.apiKey).toBe('sk-test')
    expect(auth?.source).toBe('stored credential')

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(buildSpawnEnv()).not.toHaveProperty('OPENAI_API_KEY')
    expect(Object.values(buildSpawnEnv())).not.toContain('sk-test')
  })
})
