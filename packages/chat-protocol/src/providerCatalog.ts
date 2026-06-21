/**
 * 内置提供商目录（单一来源）—— 桌面 DB 种子与扩展 settingsStore 共用，避免两套维护。
 *
 * name == id == pi-ai 的 provider slug。内置 provider 的 URL+协议+能力一律由 pi-ai 注册表
 * 按 model 决定，用户不可改 baseUrl（要自定义 URL/协议请另建自定义提供商）。
 *
 * `baseUrl` / `defaultApi` 仅作为「注册表查不到的新模型」的兜底：当 getModel 落空时，
 * 用这里声明的 baseUrl + 协议构造模型，避免回退到错误的默认协议（曾导致 kimi 404）。
 * `defaultApi` 取该 provider 在 pi-ai 注册表中模型的主流协议（pi-ai 的 Api slug）。
 */
export interface BuiltinProvider {
  /** pi-ai provider slug（同时用作 id / name） */
  name: string
  displayName: string
  /** 兜底 baseUrl（留空 '' 时由 pi-ai per-model canonical 决定，无法兜底未知模型） */
  baseUrl: string
  /** 未知模型兜底协议：pi-ai 的 Api slug（如 anthropic-messages / openai-completions） */
  defaultApi: string
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
    defaultApi: 'openai-completions'
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
  }
]
