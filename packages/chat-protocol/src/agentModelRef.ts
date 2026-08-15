/**
 * agent 档案 `shuvix-model` 取值契约 —— 「档案指定的模型」这一个字符串的解释规则。
 *
 * **写出恒为 `<providerId>/<modelId>`**，与 ModelPicker 选中模型后调 `agent.setModel`
 * 传的 `(provider, model)` 一一对应 —— 档案里存的就是那个接口收的两个值，不做简写。
 * （baseUrl / apiProtocol 不进档案：它们不是模型身份，消费时按 providerId 现查。）
 * 读取额外容忍手写的裸 `<modelId>`（无前缀 → 由消费方按模型目录找同名的那条）。
 * 省略该 key = 不声明，跟随会话 / 继承派发方。
 *
 * 放在 chat-protocol 而非 agent-runtime，是因为**三端都要用同一套规则**：设置页的编辑器
 * （渲染进程，够不到 agent-runtime）按它回填/写出选择，主进程与运行时按它把字符串解析成
 * 真实模型。规则只此一份，不许各自再实现一遍。
 */

/** `shuvix-model` 的拆分结果；provider 缺省表示值里没写前缀 */
export interface AgentModelRef {
  provider?: string
  model: string
}

/**
 * 拆 `shuvix-model` 的值 —— 按**首个** `/` 拆：providerId 不含斜杠，而模型 id 可能含
 * （OpenRouter 的 `anthropic/claude-…` 形态），所以前缀只能从左边取一段。手写的裸模型 id
 * 拆不出 provider，且写了前缀也可能其实是模型 id 的一部分 —— 故 provider 只是**候选**，
 * 是否成立由 resolveModelRef 对着模型目录判定。空值返回 null。
 */
export function parseModelRef(raw: string | null | undefined): AgentModelRef | null {
  const value = raw?.trim()
  if (!value) return null
  const slash = value.indexOf('/')
  // 首尾的斜杠不构成前缀（'/x'、'x/'）——整串当模型 id
  if (slash <= 0 || slash === value.length - 1) return { model: value }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/**
 * 把 `shuvix-model` 的值解析成模型目录里的一条：先按 `<provider>/<modelId>` 匹配
 * （写了前缀就是强意图），不中再把整串当模型 id 匹配（覆盖模型 id 自带斜杠的裸写法）。
 *
 * 都不中返回 undefined —— 档案指定的模型此刻不可用（提供商被停用 / 模型被删），
 * 回落策略交给调用方，这里不静默换一个。
 */
export function resolveModelRef<T extends { providerId: string; modelId: string }>(
  raw: string | null | undefined,
  models: readonly T[]
): T | undefined {
  const ref = parseModelRef(raw)
  if (!ref) return undefined
  if (ref.provider) {
    const prefixed = models.find((m) => m.providerId === ref.provider && m.modelId === ref.model)
    if (prefixed) return prefixed
  }
  // 整串当模型 id（前缀没匹配上，说明那一段其实是模型 id 的一部分）
  const whole = ref.provider ? `${ref.provider}/${ref.model}` : ref.model
  return models.find((m) => m.modelId === whole)
}

/**
 * 反向：把选中的 (provider, modelId) 写成 `shuvix-model` 的值 —— 恒带 providerId 前缀，
 * 与 `agent.setModel` 的入参一一对应（同名模型挂在多个提供商下时也因此不会指错）。
 * model 为空返回空串（= 清除声明）；provider 为空只写模型 id（调用方一般不会这么传）。
 */
export function formatModelRef(provider: string, model: string): string {
  if (!model) return ''
  return provider ? `${provider}/${model}` : model
}
