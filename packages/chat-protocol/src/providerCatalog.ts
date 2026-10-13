/**
 * 内置提供商目录（单一来源）—— 桌面 DB 种子与扩展 settingsStore 共用，避免两套维护。
 *
 * name == id == pi-ai 的 provider slug。内置 provider 的 URL+协议+能力一律由 pi-ai 注册表
 * 按 model 决定，用户不可改 baseUrl（要自定义 URL/协议请另建自定义提供商）。
 *
 * `baseUrl` / `defaultApi` 仅服务「注册表查不到的新模型」（agent-runtime models/catalog.ts 的
 * overlay 模型）：模板取该 provider 目录里第一个 `api === defaultApi` 的模型（端点、headers、
 * compat 照抄）；目录里没有这种协议时才用这里声明的 baseUrl + defaultApi 构造；baseUrl 留空的
 * （cloudflare-*）退回目录第一个模型。避免回退到错误的默认协议（曾导致 kimi 404）。
 * `defaultApi` 必须是该 provider 在 pi-ai 注册表中模型实际使用的协议（pi-ai 的 Api slug），
 * 否则 overlay 模型的 `api` 与 provider 真正的实现对不上（xai 曾写成 openai-completions，
 * 而 pi 1.0 的 xai 只有 openai-responses）。
 */
export interface BuiltinProvider {
  /** pi-ai provider slug（同时用作 id / name） */
  name: string
  displayName: string
  /** 兜底 baseUrl（留空 '' 时由 pi-ai per-model canonical 决定，无法兜底未知模型） */
  baseUrl: string
  /** 未知模型兜底协议：pi-ai 的 Api slug（如 anthropic-messages / openai-completions） */
  defaultApi: string
  /**
   * 只提供分类模型（pi-ai `type: 'classifier'`，走 System One 之类的分类接口，不走聊天接口）。
   * 这样的提供商没有聊天模型：设置页不给模型列表 / 同步 / 添加（改为指向「通用 → 分类模型」），
   * 模型层也不为它造 overlay 聊天模型 —— 它的协议根本不能聊天。
   */
  classifierOnly?: boolean
}

export const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  {
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultApi: 'openai-responses'
  },
  {
    name: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultApi: 'anthropic-messages'
  },
  {
    name: 'google',
    displayName: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultApi: 'google-generative-ai'
  },
  {
    name: 'xai',
    displayName: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    defaultApi: 'openai-responses'
  },
  {
    name: 'groq',
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultApi: 'openai-completions'
  },
  {
    name: 'cerebras',
    displayName: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultApi: 'openai-completions'
  },
  {
    name: 'mistral',
    displayName: 'Mistral',
    baseUrl: 'https://api.mistral.ai',
    defaultApi: 'mistral-conversations'
  },
  {
    name: 'openrouter',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultApi: 'openai-completions'
  },
  {
    name: 'minimax',
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    defaultApi: 'anthropic-messages'
  },
  {
    name: 'minimax-cn',
    displayName: 'MiniMax CN',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    defaultApi: 'anthropic-messages'
  },
  {
    name: 'huggingface',
    displayName: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    defaultApi: 'openai-completions'
  },
  {
    name: 'opencode',
    displayName: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen',
    defaultApi: 'openai-completions'
  },
  {
    name: 'kimi-coding',
    displayName: 'Kimi Coding',
    baseUrl: 'https://api.kimi.com/coding',
    defaultApi: 'anthropic-messages'
  },
  {
    name: 'zai',
    displayName: 'ZAI (智谱)',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    defaultApi: 'openai-completions'
  },
  {
    name: 'fireworks',
    displayName: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference',
    defaultApi: 'anthropic-messages'
  },
  {
    name: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultApi: 'openai-completions'
  },
  {
    name: 'moonshotai',
    displayName: 'Moonshot AI',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultApi: 'openai-completions'
  },
  {
    name: 'moonshotai-cn',
    displayName: 'Moonshot AI CN',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultApi: 'openai-completions'
  },
  {
    name: 'xiaomi',
    displayName: '小米 MiMo',
    baseUrl: 'https://token-plan-ams.xiaomimimo.com/anthropic',
    defaultApi: 'openai-completions'
  },
  // Cloudflare 系列 baseUrl 含 {CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID} 占位符，
  // 留空让 pi-ai 按 model 用 per-model canonical（故无法兜底未知模型）
  {
    name: 'cloudflare-workers-ai',
    displayName: 'Cloudflare Workers AI',
    baseUrl: '',
    defaultApi: 'openai-completions'
  },
  {
    name: 'cloudflare-ai-gateway',
    displayName: 'Cloudflare AI Gateway',
    baseUrl: '',
    defaultApi: 'openai-completions'
  },
  // 只有分类模型（Jev）：用作命令风险分类的「分类模型」，不出现在会话的模型选择里
  {
    name: 'typesafe',
    displayName: 'TypeSafe',
    baseUrl: 'https://api.typesafe.ai/v1/',
    defaultApi: 'typesafe-system-one',
    classifierOnly: true
  }
]

/** 这个内置提供商是不是只提供分类模型（按 pi slug 认） */
export function isClassifierOnlyProvider(name: string): boolean {
  return BUILTIN_PROVIDERS.some((entry) => entry.name === name && entry.classifierOnly === true)
}
