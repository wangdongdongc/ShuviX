import { type Model, type Api, type KnownProvider, getModel } from '@mariozechner/pi-ai'
import { providerDao } from '../dao/providerDao'
import type { ModelCapabilities } from '../types'
import { buildCustomProviderCompat } from './providerCompat'

/**
 * 内置提供商 → 环境变量名映射
 * pi-ai SDK 通过环境变量获取 API Key，此处将用户在 DB 中配置的 key 注入 process.env
 */
const BUILTIN_ENV_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  huggingface: 'HF_TOKEN',
  opencode: 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  zai: 'ZAI_API_KEY'
}

export interface ResolveModelParams {
  provider: string
  model: string
  capabilities: ModelCapabilities
  baseUrl?: string // setModel 传入的覆盖值
  apiProtocol?: string // setModel 传入的覆盖值
}

/**
 * 统一模型解析逻辑：从 provider + model + capabilities 解析出 pi-ai Model 对象
 * 用于 createAgent 和 setModel，消除两处重复的 ~100 行逻辑
 */
export function resolveModel(params: ResolveModelParams): Model<Api> {
  const { provider, model, capabilities: caps } = params

  const providerInfo = providerDao.findById(provider)
  const isBuiltin = providerInfo?.isBuiltin ?? false

  if (!isBuiltin) {
    // 自定义提供商：手动构造 Model 对象，用 capabilities 填充
    const inputModalities: ('text' | 'image')[] = ['text']
    if (caps.vision) inputModalities.push('image')
    const resolvedApi = (params.apiProtocol ||
      providerInfo?.apiProtocol ||
      'openai-completions') as Api
    return {
      id: model,
      name: model,
      api: resolvedApi,
      provider,
      baseUrl: params.baseUrl || providerInfo?.baseUrl || '',
      reasoning: caps.reasoning ?? false,
      input: inputModalities,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: caps.maxInputTokens ?? 128000,
      maxTokens: caps.maxOutputTokens ?? 16384,
      ...(buildCustomProviderCompat(resolvedApi)
        ? { compat: buildCustomProviderCompat(resolvedApi) }
        : {})
    }
  }

  // 内置提供商：通过 SDK 解析（name 即 pi-ai 的 provider slug）
  const slug = (providerInfo?.name || '').toLowerCase()
  if (providerInfo?.apiKey) {
    const envKey = BUILTIN_ENV_MAP[slug]
    if (envKey) {
      process.env[envKey] = providerInfo.apiKey
    }
  }

  let resolvedModel: Model<Api>
  const piModel = getModel(slug as KnownProvider, model as Parameters<typeof getModel>[1])
  if (piModel) {
    resolvedModel = piModel
    resolvedModel.provider = provider
    if (params.baseUrl || providerInfo?.baseUrl) {
      resolvedModel.baseUrl = params.baseUrl || providerInfo!.baseUrl!
    }
  } else {
    // 模型不在 pi-ai 注册表中（如远程同步到的新模型），按自定义方式构造
    const inputModalities: ('text' | 'image')[] = ['text']
    if (caps.vision) inputModalities.push('image')
    const resolvedApi = (params.apiProtocol ||
      providerInfo?.apiProtocol ||
      'openai-completions') as Api
    resolvedModel = {
      id: model,
      name: model,
      api: resolvedApi,
      provider,
      baseUrl: params.baseUrl || providerInfo?.baseUrl || '',
      reasoning: caps.reasoning ?? false,
      input: inputModalities,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: caps.maxInputTokens ?? 128000,
      maxTokens: caps.maxOutputTokens ?? 16384,
      ...(buildCustomProviderCompat(resolvedApi)
        ? { compat: buildCustomProviderCompat(resolvedApi) }
        : {})
    }
  }

  // 为 Kimi Coding 注入 coding agent 标识（Kimi API 要求特定 User-Agent）
  if (resolvedModel.baseUrl?.includes('api.kimi.com')) {
    resolvedModel.headers = { ...resolvedModel.headers, 'User-Agent': 'Claude-Code/1.0.0' }
  }

  return resolvedModel
}
