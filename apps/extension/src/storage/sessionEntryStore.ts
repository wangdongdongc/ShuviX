/**
 * 会话转写存储（扩展端）—— 与桌面同一形态：pi 原装 `JsonlSessionStorage`。
 *
 * 每个会话一个 OPFS 文件 `/sessions/<sessionId>.jsonl`（header 行 + 每行一条
 * SessionTreeEntry，append-only），读写经 opfsSessionFs 的 dedicated Worker
 * sync access handle（真 O(1) 尾追加，见 OPFS 探针结论）。
 *
 * 取代原 IdbSessionStorage（IndexedDB 行存储 + write-behind 缓存）：两端从此共用
 * 同一存储格式与同一段 pi 代码路径，会话文件可直接互通/导出。
 *
 * 快照型存储要求**单实例**：所有构造路径都必须经本模块的共享 registry
 * （内核 @shuvix/agent-runtime createSessionTreeRegistry —— 在途去重 / LRU / 钉住）。
 */
import { JsonlSessionStorage, Session } from '@earendil-works/pi-agent-core'
import { createSessionTreeRegistry } from '@shuvix/agent-runtime'
import { createOpfsSessionEnv } from './opfsSessionFs'

const env = createOpfsSessionEnv()

/** 某会话的转写文件路径（OPFS 命名空间内） */
function sessionFilePath(sessionId: string): string {
  return `/sessions/${sessionId}.jsonl`
}

const registry = createSessionTreeRegistry({
  open: async (sessionId) =>
    new Session(await JsonlSessionStorage.open(env, sessionFilePath(sessionId))),
  // pi 的 open() 校验 header cwd 非空而 create() 不校验 —— 空 cwd 兜底到 /sessions
  create: async (sessionId, cwd) =>
    new Session(
      await JsonlSessionStorage.create(env, sessionFilePath(sessionId), {
        cwd: cwd || '/sessions',
        sessionId
      })
    ),
  exists: async (sessionId) => {
    const r = await env.exists(sessionFilePath(sessionId))
    return r.ok ? r.value : false
  }
})

/**
 * 注册一条钉住判定 —— 可叠加，任一为真即钉住（与桌面端同形）。
 * 覆盖式 setter 会让后注册者静默吃掉前一个，症状是「有些会话偶尔丢消息」。
 */
const pinPredicates: Array<(sessionId: string) => boolean> = []

export function addSessionTreePin(fn: (sessionId: string) => boolean): void {
  pinPredicates.push(fn)
  registry.setPinned((sessionId) => pinPredicates.some((p) => p(sessionId)))
}

/** 取共享会话树；文件不存在时返回 null（不创建） —— 读取路径用 */
export async function getSessionTree(sessionId: string): Promise<Session | null> {
  return await registry.get(sessionId)
}

/** 取共享会话树，不存在则创建 —— 写路径（运行时创建 / Agent 未建时的配置追加）用 */
export async function ensureSessionTree(sessionId: string, cwd = ''): Promise<Session> {
  return await registry.ensure(sessionId, cwd)
}

/** 删除某会话的转写文件（幂等），并逐出共享缓存 */
export async function deleteSessionFile(sessionId: string): Promise<void> {
  registry.evict(sessionId)
  const r = await env.remove(sessionFilePath(sessionId))
  if (!r.ok) console.error('[shuvix] 删除会话文件失败', sessionId, r.error.message)
}

// ─── 运行配置：会话树是唯一事实源（与桌面 readSessionRunConfig 同构） ─────────

export interface SessionRunConfig {
  provider: string | null
  model: string | null
  thinkingLevel: string | null
  enabledTools: string[] | null
}

/**
 * 从会话树读出当前运行配置。文件不存在或树上没有对应 entry → 该项 null（调用方回落默认）。
 * 只看当前分支（getBranch）；不能用压缩过滤后的 entry —— 早于切点的 model_change 依然有效。
 */
export async function readSessionRunConfig(sessionId: string): Promise<SessionRunConfig> {
  const config: SessionRunConfig = {
    provider: null,
    model: null,
    thinkingLevel: null,
    enabledTools: null
  }
  const session = await getSessionTree(sessionId)
  if (!session) return config
  for (const entry of await session.getBranch()) {
    if (entry.type === 'model_change') {
      config.provider = entry.provider
      config.model = entry.modelId
    } else if (entry.type === 'thinking_level_change') {
      config.thinkingLevel = entry.thinkingLevel
    } else if (entry.type === 'active_tools_change') {
      config.enabledTools = entry.activeToolNames
    }
  }
  return config
}

/** 往会话树追加一条 model_change（Agent 未创建时的写入路径） */
export async function appendModelChange(
  sessionId: string,
  provider: string,
  modelId: string
): Promise<void> {
  await (await ensureSessionTree(sessionId)).appendModelChange(provider, modelId)
}

/** 往会话树追加一条 thinking_level_change */
export async function appendThinkingLevelChange(
  sessionId: string,
  thinkingLevel: string
): Promise<void> {
  await (await ensureSessionTree(sessionId)).appendThinkingLevelChange(thinkingLevel)
}

/** 往会话树追加一条 active_tools_change */
export async function appendActiveToolsChange(
  sessionId: string,
  activeToolNames: string[]
): Promise<void> {
  await (await ensureSessionTree(sessionId)).appendActiveToolsChange(activeToolNames)
}
