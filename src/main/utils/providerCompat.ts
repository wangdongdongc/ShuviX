/**
 * 自定义提供商兼容性配置
 *
 * pi-ai 库会根据 baseUrl 自动检测兼容性设置，但只识别有限的已知提供商（OpenAI、Anthropic 等）。
 * 对于自定义/第三方提供商（如 Kimi、DeepSeek 等），自动检测可能不准确，
 * 因此我们在这里集中管理保守的默认值。
 *
 * 每个字段的含义：
 * - supportsStore:              是否发送 store 参数（false → 不发送，避免 reasoning summary 404）
 * - supportsDeveloperRole:      是否使用 developer 角色替代 system（false → 始终用 system）
 * - supportsReasoningEffort:    是否发送 reasoning_effort 参数
 * - supportsUsageInStreaming:   流式响应中是否包含 token 用量
 * - maxTokensField:             控制最大 token 的字段名
 */

/** 适用于绝大多数 OpenAI 兼容第三方 API 的保守默认值 */
const DEFAULT_CUSTOM_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: 'max_completion_tokens' as const
}

/**
 * 为自定义提供商构造兼容性配置。
 * 仅对 openai-completions 协议生效，其他协议由 pi-ai 内部处理。
 *
 * @param apiProtocol - 提供商使用的 API 协议
 * @param overrides   - 可选的 per-provider 覆盖（未来可从 DB 读取）
 */
export function buildCustomProviderCompat(
  apiProtocol: string,
  overrides?: Partial<typeof DEFAULT_CUSTOM_COMPAT>
): Record<string, unknown> | undefined {
  if (apiProtocol !== 'openai-completions') {
    return undefined
  }

  return {
    ...DEFAULT_CUSTOM_COMPAT,
    ...overrides
  }
}
