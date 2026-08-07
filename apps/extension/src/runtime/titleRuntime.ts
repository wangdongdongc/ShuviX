/**
 * 浏览器会话标题生成适配器 —— 复用 @shuvix/agent-runtime 的共享内核（与桌面同源）：
 * 模型调用走 generateSessionTitle，两阶段触发策略走 SessionTitler。
 *
 * 对齐桌面 agentSession.generateTitle：仅用「设置中的标题模型」(general.titleProvider/titleModel)，
 * 未配置或无 API Key 直接返回 null（触发层据此跳过，不浪费调用、不覆盖默认标题）。
 * 标题模型经设置页 ModelDefaultsSettings 配置（见 ExtAppearanceTab）。
 */
import i18n from 'i18next'
import { generateSessionTitle, SessionTitler } from '@shuvix/agent-runtime'
import { sessionStore } from '../storage/sessionStore'
import { messageStore } from '../storage/messageStore'
import { settingsStore } from '../storage/settingsStore'
import { capsFor, resolveSessionModel } from './resolveSessionModel'
import { appEventBus } from './appEventBus'

/** 调标题模型产出标题；未配置标题模型 / 无 API Key → null（不浪费调用） */
async function runTitleModel(conversationText: string): Promise<string | null> {
  await settingsStore.loadState()
  const provider = await settingsStore.get('general.titleProvider')
  const model = await settingsStore.get('general.titleModel')
  if (!provider || !model) return null

  const apiKey = settingsStore.getApiKey(provider)
  if (!apiKey) return null

  const resolved = resolveSessionModel(provider, model, capsFor(model))
  return generateSessionTitle({ model: resolved, apiKey, conversationText })
}

/** 标题落库 + 广播 AppEvent（chat-ui 的 session.titleChanged 订阅据此刷新会话列表） */
async function applyTitle(sessionId: string, title: string): Promise<void> {
  await sessionStore.updateTitle(sessionId, title)
  appEventBus.publish({ type: 'session.titleChanged', sessionId, title })
}

// 每会话一个 titler（持有 quick/refine 是否已完成 + 上次自动标题），生命周期同 Side Panel 运行时
const titlers = new Map<string, SessionTitler>()

/**
 * 取（或惰性创建）某会话的两阶段自动标题触发器。
 * quick 由 HarnessSession 的 onPromptAccepted 触发，refine 由 chatApiAdapter 在一轮结束后触发。
 */
export function titlerFor(sessionId: string): SessionTitler {
  let titler = titlers.get(sessionId)
  if (!titler) {
    titler = new SessionTitler({
      getCurrentTitle: async () => (await sessionStore.getById(sessionId))?.title ?? null,
      getDefaultTitle: () => i18n.t('agent.defaultTitle'),
      listMessages: () => messageStore.list(sessionId),
      generate: runTitleModel,
      applyTitle: (title) => applyTitle(sessionId, title),
      warn: (message) => console.warn('[shuvix]', message)
    })
    titlers.set(sessionId, titler)
  }
  return titler
}

/** 会话删除时清理触发器状态 */
export function removeTitler(sessionId: string): void {
  titlers.delete(sessionId)
}

/** ChatApi.session.generateTitle：显式生成一次并落库 + 广播（不经两阶段状态机） */
export async function generateTitleForSession(
  sessionId: string,
  conversationText: string
): Promise<string | null> {
  try {
    const title = await runTitleModel(conversationText)
    if (title) await applyTitle(sessionId, title)
    return title
  } catch (e) {
    console.warn('[shuvix] 标题生成失败', e)
    return null
  }
}
