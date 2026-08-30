/**
 * 浏览器 Agent 运行时 —— 根会话经统一创建管线（runtime/agentHost 的 extensionAgentFactory）
 * 在 Side Panel 进程内驱动 pi AgentHarness，事件经 eventBus 派发给 chat-ui。
 * 档案：笔记本会话恒为 notebook 基座，其余按 settings.agentProfile（缺省 'default'）。
 *
 * 与桌面 AgentSession 的对应：这里是「扩展宿主 wrapper」——生命周期簿记（SessionManager）
 * 与运行配置读写；工具装配 / systemPrompt 组装 / instruction 懒注入全部收敛在 agentHost。
 * instruction 注入方式与桌面统一：custom_message entry（懒注入、压缩后重注入），
 * 不再拼进 systemPrompt 字符串。
 */
import {
  DEFAULT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  SessionManager,
  resolveInitialThinkingLevel,
  toInProcessAgentType,
  type CreatedAgent
} from '@shuvix/agent-runtime'
import {
  appendModelChange,
  readSessionRunConfig,
  addSessionTreePin
} from '../storage/sessionEntryStore'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import type { SessionModelMetadata } from '@shuvix/chat-protocol/chatApi'
import { sessionStore } from '../storage/sessionStore'
import { settingsStore } from '../storage/settingsStore'
import { projectStore } from '../storage/projectStore'
import { capsFor } from './resolveSessionModel'
import { titlerFor } from './titleRuntime'
import { extensionAgentFactory } from './agentHost'
import { clearSessionTools, extensionSubAgentRegistry, subAgentManager } from './subAgent'
import { eventBus } from './eventBus'

/**
 * 会话运行时生命周期由共享 SessionManager 托管（Map + 懒创建 + 失效/销毁）。
 * 构造经 buildRuntimeSession 注入（异步：FSA/OPFS + 档案解析）；清理 dispose 销毁子代理 + 工具注册表。
 */
const manager = new SessionManager<CreatedAgent>({
  create: (sessionId) => buildRuntimeSession(sessionId),
  dispose: async (sessionId, created) => {
    // 先把当前 run 停下并**等它停住**：解绑必须发生在关停之后，否则旧 run 还会继续
    // 往同一棵会话树上写，和新运行时交叉（见 SessionManager 顶部注释）
    try {
      await created.runtime.abort()
    } catch {
      /* 中止失败不影响后续清理：abort 返回时它已经不在跑了 */
    }
    // 运行时被弃用 —— 从运行时注册中心注销，避免留下指向死 harness 的条目
    created.dispose()
    subAgentManager.destroyAll(sessionId)
    clearSessionTools(sessionId)
  },
  onClosingChange: (sessionId, closing) =>
    eventBus.emit({ type: 'agent_closing', sessionId, closing })
})

// 会话树共享缓存的逐出保护：有运行时（或创建中）的会话，树实例与 harness 共享，LRU 不得回收
addSessionTreePin((sessionId) => manager.tracked(sessionId))

/**
 * 解析会话的 provider/model/caps（**不创建运行时**）—— 供 agent.init 同步元信息。
 * Agent 运行时延迟到首次发送消息（ensureRuntimeSession）才创建，故仅打开会话/笔记本不启动 Agent。
 */
export async function resolveSessionMeta(sessionId: string): Promise<{
  provider: string
  model: string
  caps: ModelCapabilities
  modelMetadata: SessionModelMetadata
}> {
  await settingsStore.loadState()
  const def = settingsStore.getDefaultSelection()
  // 运行配置的唯一事实源是会话树；树上没有（新会话）才回落活跃选择
  const tree = await readSessionRunConfig(sessionId)
  const provider = tree.provider ?? def.provider
  const model = tree.model ?? def.model
  return {
    provider,
    model,
    caps: capsFor(model),
    modelMetadata: {
      ...(tree.thinkingLevel ? { thinkingLevel: tree.thinkingLevel } : {}),
      ...(tree.enabledTools ? { enabledTools: tree.enabledTools } : {})
    }
  }
}

/** 取（或惰性创建）某会话的运行时（懒创建经 SessionManager） */
export function ensureRuntimeSession(sessionId: string): Promise<CreatedAgent | undefined> {
  return manager.ensure(sessionId)
}

/** 构造某会话的根运行时（SessionManager.create 注入）—— 统一创建管线；档案见下方解析 */
async function buildRuntimeSession(sessionId: string): Promise<CreatedAgent> {
  const { provider, model, caps } = await resolveSessionMeta(sessionId)
  const session = await sessionStore.getById(sessionId)
  await projectStore.loadState()
  const projectHandle = session?.projectId ? projectStore.getHandle(session.projectId) : undefined
  // 工作目录（虚拟标签）：项目会话用文件夹名，临时会话用 'scratch'
  const cwd = projectHandle?.name ?? 'scratch'

  // 会话档案：笔记本会话（settings.notebookPath 非空）恒为 notebook 基座档案，忽略 agentProfile；
  // 其余按 `/<agentName>` 切换写入的 settings.agentProfile，缺省 / 档案已不存在 → 回落 'default'
  // （扩展注册表无用户档案，内置兜底恒存在）
  const profileName = session?.settings?.notebookPath
    ? NOTEBOOK_PROFILE_NAME
    : session?.settings?.agentProfile
  const profile = toInProcessAgentType(
    (profileName ? extensionSubAgentRegistry.getProfile(profileName) : undefined) ??
      extensionSubAgentRegistry.getProfile(DEFAULT_PROFILE_NAME)!
  )

  return await extensionAgentFactory.createAgent({
    kind: 'root',
    sessionId,
    profile,
    model: { provider, model, capabilities: caps },
    thinkingLevel: resolveInitialThinkingLevel({
      persisted: (await readSessionRunConfig(sessionId)).thinkingLevel ?? undefined,
      reasoning: caps.reasoning
    }),
    cwd,
    // UserPromptSubmit 通过、正式派发前触发首轮快速标题（与桌面同一时序 + 同一策略内核）
    onPromptAccepted: (text) => void titlerFor(sessionId).quick(text)
  })
}

export function getRuntimeSession(sessionId: string): CreatedAgent | undefined {
  return manager.get(sessionId)
}

/**
 * 切换会话模型 —— 唯一写入口。
 *
 * Agent 已创建 → 统一管线 applyModel（harness 自己往会话树追加 model_change，
 * 并同步更新派发工具的当前模型配置）；未创建 → 直接往树上追加，不为了记一次配置把 Agent 拉起来。
 */
export async function setSessionModel(
  sessionId: string,
  provider: string,
  model: string
): Promise<void> {
  const created = manager.get(sessionId)
  if (!created) {
    await appendModelChange(sessionId, provider, model)
    return
  }
  await created.applyModel({ provider, model, capabilities: capsFor(model) })
}

/**
 * 关停并解绑某会话的运行时。**返回的 Promise 落定时旧 run 保证已停** ——
 * 调用方要动会话树（回退 / 清空 / 删除）必须先 await 它。
 */
export function removeRuntimeSession(sessionId: string): Promise<void> {
  // 销毁子代理 + 清理工具注册表由 SessionManager 的 dispose 处理
  return manager.remove(sessionId, 'remove')
}
