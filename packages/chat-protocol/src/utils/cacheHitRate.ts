/**
 * 提示词缓存命中率 —— 按 token 加权：命中 / （未命中 + 命中 + 写入）。
 *
 * 三项是 pi 归一后的 usage（`input` 已扣掉缓存部分，三者互不重叠），各家 API 的原始字段
 * 口径不同（Anthropic 的 input_tokens 本就不含缓存；OpenAI 系的 prompt_tokens 含 cached_tokens），
 * 归一在 pi 的各个适配器里做完了，这里不再关心来自哪家。
 *
 * 分母为 0（还没有计入任何输入）回 null —— 「没有数据」不是 0%。
 * 「provider 从不上报缓存」同样不是 0%，但那要看累计里有没有出现过缓存字段，调用方
 * 用 `AgentMonitorCacheUsage.reported` 判断，本函数只做算术。
 */
export function cacheHitRate(usage: {
  input: number
  cacheRead: number
  cacheWrite: number
}): number | null {
  const total = usage.input + usage.cacheRead + usage.cacheWrite
  return total > 0 ? usage.cacheRead / total : null
}
