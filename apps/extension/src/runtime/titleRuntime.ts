/**
 * 浏览器会话标题生成适配器 —— 复用 @shuvix/agent-runtime 的共享内核：
 * 模型调用走 generateSessionTitle，两阶段触发策略走 SessionTitler。
 *
 * 模型恒随**会话当前模型**（resolveSessionMeta：会话树 → 默认选择），与桌面的
 * workflow 化 titler 同一口径 —— 旧的「标题模型」专项设置（general.titleProvider/
 * titleModel）已整体废弃。无可用模型 / 无 API Key 返回 null（触发层据此跳过，
 * 不浪费调用、不覆盖默认标题）。
 */
import i18n from 'i18next'
import { generateSessionTitle, SessionTitler } from '@shuvix/agent-runtime'
import { sessionStore } from '../storage/sessionStore'
import { messageStore } from '../storage/messageStore'
import { settingsStore } from '../storage/settingsStore'
import { resolveSessionMeta } from './agentRuntime'
import { resolveSessionModel } from './resolveSessionModel'
import { appEventBus } from './appEventBus'

/** 以会话当前模型产出标题；无可用模型 / 无 API Key → null（不浪费调用） */
async function runTitleModel(sessionId: string, conversationText: string): Promise<string | null> {
  const { provider, model, caps } = await resolveSessionMeta(sessionId)
  if (!provider || !model) return null

  const apiKey = settingsStore.getApiKey(provider)
  if (!apiKey) return null

  const resolved = resolveSessionModel(provider, model, caps)
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
      generate: (conversationText) => runTitleModel(sessionId, conversationText),
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

// 注：generateTitleForSession（ChatApi.session.generateTitle 的实现）已随该契约成员
// 一并删除 —— 它没有任何 UI 调用方；扩展的自动标题仍走上面的两阶段 titlerFor 状态机。
