/**
 * 远程拉取提供商模型列表（宿主无关，纯 fetch + 解析）——桌面与扩展共用同步逻辑。
 * 按协议分派到 OpenAI 兼容 / Google Generative AI 的 /models 端点。
 */

/** 从 OpenAI 兼容端点拉取模型 id 列表 */
export async function fetchOpenAIModels(apiKey: string, baseUrl?: string): Promise<string[]> {
  const normalizedBaseUrl = (baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const response = await fetch(`${normalizedBaseUrl}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenAI 模型拉取失败（${response.status}）：${errText}`)
  }
  const payload = (await response.json()) as { data?: Array<{ id?: string }> }
  const modelIds = (payload.data || [])
    .map((item) => item.id?.trim())
    .filter((id): id is string => Boolean(id))
  if (modelIds.length === 0) throw new Error('OpenAI 返回的模型列表为空')
  return [...new Set(modelIds)].sort((a, b) => a.localeCompare(b))
}

/** 从 Google Generative AI 拉取模型 id 列表 */
export async function fetchGoogleModels(apiKey: string, baseUrl?: string): Promise<string[]> {
  let normalizedBaseUrl = (baseUrl?.trim() || 'https://generativelanguage.googleapis.com').replace(
    /\/+$/,
    ''
  )
  if (!normalizedBaseUrl.match(/\/v\d/)) normalizedBaseUrl += '/v1beta'
  const url = `${normalizedBaseUrl}/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Google 模型拉取失败（${response.status}）：${errText}`)
  }
  const payload = (await response.json()) as { models?: Array<{ name?: string }> }
  const modelIds = (payload.models || [])
    .map((item) => item.name?.replace(/^models\//, '').trim())
    .filter((id): id is string => Boolean(id))
  if (modelIds.length === 0) throw new Error('Google 返回的模型列表为空')
  return [...new Set(modelIds)].sort((a, b) => a.localeCompare(b))
}

/** 按协议分派拉取模型列表 */
export async function fetchProviderModels(params: {
  apiProtocol: string
  apiKey: string
  baseUrl?: string
}): Promise<string[]> {
  const { apiProtocol, apiKey, baseUrl } = params
  if (apiProtocol === 'openai-completions' || apiProtocol === 'openai-responses') {
    return fetchOpenAIModels(apiKey, baseUrl)
  }
  if (apiProtocol === 'google-generative-ai') {
    return fetchGoogleModels(apiKey, baseUrl)
  }
  throw new Error('该协议类型暂不支持自动同步模型')
}
