/**
 * 各家内置提供商的 key 环境变量一律置空（空串 = 没设）—— 交给 `launchApp({ env: PROVIDER_KEY_ENV })`。
 *
 * 实例继承 vitest 进程的环境，而桌面模型注册表对内置提供商仍会读 env 里的 key（pi 的 envApiKeyAuth）。
 * 分类模型挂在内置提供商上：开发机上设着的 key 会让命令分类真的去请求 OpenRouter / OpenCode /
 * Cloudflare —— 要钱，也不可复现。凡是可能碰到分类器（或别的内置提供商）的 spec，每次启动都带上它。
 */
export const PROVIDER_KEY_ENV: Record<string, string> = {
  OPENROUTER_API_KEY: '',
  OPENCODE_API_KEY: '',
  CLOUDFLARE_API_KEY: '',
  CLOUDFLARE_ACCOUNT_ID: '',
  AI_GATEWAY_API_KEY: '',
  TYPESAFE_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  GEMINI_API_KEY: ''
}
