/** API 协议类型（用户可选） */
export type ApiProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

/** 协议选项列表（UI 下拉框 + 类型守卫共用） */
export const API_PROTOCOL_OPTIONS: Array<{ value: ApiProtocol; labelKey: string }> = [
  { value: 'openai-completions', labelKey: 'settings.protocolOpenAI' },
  { value: 'openai-responses', labelKey: 'settings.protocolOpenAIResponses' },
  { value: 'anthropic-messages', labelKey: 'settings.protocolAnthropic' },
  { value: 'google-generative-ai', labelKey: 'settings.protocolGoogle' }
]
