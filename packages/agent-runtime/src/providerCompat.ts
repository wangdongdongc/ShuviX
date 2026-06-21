/**
 * 自定义提供商兼容性配置（宿主无关，纯逻辑）
 *
 * pi-ai 库根据 baseUrl 自动检测兼容性，但只识别有限的已知提供商。对于自定义/第三方
 * 提供商（Kimi、DeepSeek 等），此处集中管理保守默认值。
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
 * 为自定义提供商构造兼容性配置。仅对 openai-completions 协议生效，其他协议由 pi-ai 内部处理。
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
