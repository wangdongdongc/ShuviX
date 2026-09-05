/**
 * 模型解析（宿主无关）：从 provider + model + capabilities + providerInfo 解析出 pi-ai Model 对象。
 *
 * 与桌面版的区别：
 *  - providerInfo 由宿主通过参数传入（替代 providerDao.findById）
 *  - apiKey 注入走 RuntimeEnv.setApiKey（替代直接写 process.env；浏览器宿主 no-op）
 */
import type { Model, Api } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
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

const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 16384

/**
 * 从能力数据得出 contextWindow / maxTokens（自定义提供商与注册表查不到的内置模型走这里）。
 *
 * 输出上限只在「大于 0 且严格小于窗口」时可信。litellm 的目录里有一大类条目把窗口值原样填进
 * max_output_tokens（随包目录 1976 条 chat 模型里 751 条 max_output == max_input，
 * xai/*、azure_ai/grok-*、openrouter/x-ai/* 整族如此，官方并没有公布过那样的输出上限），
 * 另有少数 max_output > max_input 的。这样的值当「未知」处理，与缺失走同一条默认路 ——
 * 一个大于等于窗口的输出上限在任何请求里都兑现不了。0 与负数同理（能力对话框里手填 0
 * 会真的落库；0 原样交给 pi 会变成 max_tokens: 0）。窗口本身缺失时按默认窗口比较。
 *
 * 归一放在这里而不是 litellm 入口：能力数据早已落库（fillMissingCapabilities 不覆盖已有值），
 * 用户也可能在能力对话框里手填；这里是两个宿主构造 Model 的唯一汇合点。
 * 压缩阈值那边另有 OUTPUT_RESERVE_CAP 兜底（见 harnessSession），不依赖这里。
 */
function resolveTokenLimits(caps: ModelCapabilities): { contextWindow: number; maxTokens: number } {
  const contextWindow = caps.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW
  const maxOutput = caps.maxOutputTokens
  const maxTokens =
    maxOutput != null && maxOutput > 0 && maxOutput < contextWindow ? maxOutput : DEFAULT_MAX_TOKENS
  return { contextWindow, maxTokens }
}

/** 从 provider + model + capabilities 解析出 pi-ai Model 对象 */
export function resolveModel(params: ResolveModelParams): Model<Api> {
  const { provider, model, capabilities: caps, providerInfo, env } = params
  const isBuiltin = providerInfo?.isBuiltin ?? false
  const limits = resolveTokenLimits(caps)

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
      // 思考能力与用户配置的能力点解绑：动态模型（自定义/未知内置）一律声明可推理，
      // 实际是否思考由会话 thinkingLevel 控制。
      // 否则 pi-ai 会因 reasoning=false 把 thinkingLevel 夹回 off，导致用户选了却发不出去。
      reasoning: true,
      input: inputModalities,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxTokens,
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
  const piModel = getBuiltinModel(
    // 不能用 KnownProvider：pi-ai 的 KnownProvider 比 getBuiltinModel 实际接受的
    // provider 联合更宽（如 'radius'），直接取形参类型才不会漂移。
    slug as Parameters<typeof getBuiltinModel>[0],
    model as Parameters<typeof getBuiltinModel>[1]
  )
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
      // 同上：未知内置模型也声明可推理，思考开关交给 thinkingLevel
      reasoning: true,
      input: inputModalities,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxTokens,
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
