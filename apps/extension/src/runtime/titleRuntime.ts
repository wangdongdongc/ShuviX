/**
 * 浏览器会话标题生成适配器 —— 复用 @shuvix/agent-runtime 的 generateSessionTitle（与桌面同源）。
 *
 * 对齐桌面 agentSession.generateTitle：仅用「设置中的标题模型」(general.titleProvider/titleModel)，
 * 未配置或无 API Key 直接返回 null（chat-ui 触发层据此跳过，不浪费调用、不覆盖默认标题）。
 * 标题模型经设置页 ModelDefaultsSettings 配置（见 ExtAppearanceTab）。
 */
import { generateSessionTitle } from '@shuvix/agent-runtime'
import { sessionStore } from '../storage/sessionStore'
import { settingsStore } from '../storage/settingsStore'
import { resolveSessionModel } from './resolveSessionModel'
import { capsFor } from './agentRuntime'

export async function generateTitleForSession(
  sessionId: string,
  conversationText: string
): Promise<string | null> {
  await settingsStore.loadState()
  const provider = await settingsStore.get('general.titleProvider')
  const model = await settingsStore.get('general.titleModel')
  if (!provider || !model) return null

  const apiKey = settingsStore.getApiKey(provider)
  if (!apiKey) return null

  try {
    const caps = capsFor(model)
    const resolved = resolveSessionModel(provider, model, caps)
    const title = await generateSessionTitle({ model: resolved, apiKey, conversationText })
    if (title) await sessionStore.updateTitle(sessionId, title)
    return title
  } catch (e) {
    console.warn('[shuvix] 标题生成失败', e)
    return null
  }
}
