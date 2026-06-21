/**
 * 模型解析（宿主无关）：从 provider + model + capabilities + providerInfo 解析出 pi-ai Model 对象。
 *
 * 与桌面版的区别：
 *  - providerInfo 由宿主通过参数传入（替代 providerDao.findById）
 *  - apiKey 注入走 RuntimeEnv.setApiKey（替代直接写 process.env；浏览器宿主 no-op）
 */
import { type Model, type Api, type KnownProvider, getModel } from '@earendil-works/pi-ai'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { BUILTIN_PROVIDERS } from '@shuvix/chat-protocol/providerCatalog'
import { buildCustomProviderCompat } from './providerCompat'
import type { RuntimeEnv } from './types'

/**
 * 内置提供商 → 环境变量名映射。
 * pi-ai SDK 可通过环境变量获取 API Key，此处把用户配置的 key 经 RuntimeEnv 注入。
 */
export const BUILTIN_ENV_MAP: Record<string, string> = {
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
  zai: 'ZAI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
  'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY'
}

/** 解析模型所需的提供商信息（宿主从自己的存储读取后传入） */
export interface ResolveModelProviderInfo {
  id: string
  name: string
  isBuiltin: boolean
  apiKey?: string
  baseUrl?: string
  apiProtocol?: string
  /** JSON 字符串，如 { customHeaders: { "X-Key": "val" } } */
  metadata?: string
}

export interface ResolveModelParams {
  provider: string
  model: string
  capabilities: ModelCapabilities
  baseUrl?: string
  apiProtocol?: string
  /** 宿主查到的提供商信息（null = 未知，按自定义处理） */
  providerInfo: ResolveModelProviderInfo | null
  /** 环境变量注入器 */
  env: RuntimeEnv
}

/** 从 provider + model + capabilities 解析出 pi-ai Model 对象 */
export function resolveModel(params: ResolveModelParams): Model<Api> {
  const { provider, model, capabilities: caps, providerInfo, env } = params
  const isBuiltin = providerInfo?.isBuiltin ?? false

  if (!isBuiltin) {
    // 自定义提供商：手动构造 Model 对象
    const inputModalities: ('text' | 'image')[] = ['text']
    if (caps.vision) inputModalities.push('image')
    const resolvedApi = (params.apiProtocol ||
      providerInfo?.apiProtocol ||
      'openai-completions') as Api
    let customHeaders: Record<string, string> | undefined
    if (providerInfo?.metadata) {
      try {
        const meta = JSON.parse(providerInfo.metadata)
        if (meta?.customHeaders && typeof meta.customHeaders === 'object') {
          const h = meta.customHeaders
          if (Object.keys(h).length > 0) customHeaders = h
        }
      } catch {
        // 忽略无效 JSON
      }
    }
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
        : {}),
      ...(customHeaders ? { headers: customHeaders } : {})
    }
  }

  // 内置提供商：通过 SDK 解析（name 即 pi-ai 的 provider slug）
  const slug = (providerInfo?.name || '').toLowerCase()
  if (providerInfo?.apiKey) {
    const envKey = BUILTIN_ENV_MAP[slug]
    if (envKey) {
      env.setApiKey(envKey, providerInfo.apiKey)
    }
  }

  let resolvedModel: Model<Api>
  const piModel = getModel(slug as KnownProvider, model as Parameters<typeof getModel>[1])
  if (piModel) {
    // 已知模型：URL/协议/headers/能力完全采用注册表定义，不接受用户 baseUrl 覆盖
    // （内置 provider 不支持自定义 URL；要自定义请另建自定义提供商）
    resolvedModel = piModel
  } else {
    // 未知新模型（注册表查不到）：用 BUILTIN_PROVIDERS 声明的兜底协议 + baseUrl 构造，
    // 避免回退到错误的默认协议（曾导致 kimi 用 openai-completions 打错端点 → 404）
    const builtin = BUILTIN_PROVIDERS.find((p) => p.name === slug)
    const resolvedApi = (builtin?.defaultApi || 'openai-completions') as Api
    const inputModalities: ('text' | 'image')[] = ['text']
    if (caps.vision) inputModalities.push('image')
    resolvedModel = {
      id: model,
      name: model,
      api: resolvedApi,
      provider,
      baseUrl: builtin?.baseUrl || '',
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

  // Kimi Coding 需要特定 User-Agent
  if (resolvedModel.baseUrl?.includes('api.kimi.com')) {
    resolvedModel.headers = { ...resolvedModel.headers, 'User-Agent': 'Claude-Code/1.0.0' }
  }

  return resolvedModel
}
