/**
 * 会话转写存储 —— 直接复用 pi 自带的 `JsonlSessionStorage`。
 *
 * 每个会话一个 `<userData>/data/sessions/<sessionId>.jsonl`：
 *   第 1 行是 header（`{type:"session", version, id, timestamp, cwd, ...}`），
 *   之后每行一条 SessionTreeEntry。append-only，纯文本。
 *
 * 为什么不自建 SQLite 表：ShuviX 从不调用 `SessionRepo.list()` —— 会话列表来自
 * `sessions` 表的一条 SQL，分组/筛选在渲染进程做。真正需要的只有「按 sessionId
 * 单开一个 SessionStorage」，这件事 JSONL 做得更好：`open()` 一次把文件读进内存，
 * 之后 getEntry / getPathToRoot / findEntries 全是内存 Map 操作，而不是每次回表。
 *
 * **进程内单实例（registry）**：`open()` 是全量读 + 逐行 parse，而一次会话切换会有
 * message.list / agent.init / readSessionRunConfig 多路并发读取 —— 各开各的实例等于把同一个
 * 文件加载多遍。这里把「sessionId → Session」收敛成进程内共享缓存：
 *   - 并发/先后到达的读取共享同一次加载（在途 Promise 去重）；
 *   - Agent（HarnessSession）拿到的也是同一个实例 —— 运行期追加直接可见，
 *     回滚 moveTo、模型切换 append 与读取端天然一致，不再依赖「重开文件」自愈；
 *   - 一致性前提：**所有**打开路径都走本模块（本模块是桌面端唯一构造
 *     JsonlSessionStorage 的地方），外部手改文件不在支持范围内。
 *   - 逐出：删除会话时显式逐出；无 Agent 的旁观会话按 LRU 限量（图片以 base64 内联
 *     在 entry 里，重图会话一棵树几十 MB，不能无界攒）。有 Agent 的会话被钉住，
 *     判定经 `addSessionTreePin` 注册（可叠加：有根会话看 agents.tracked，聊天会话看
 *     botService.isActive）。
 *
 * 分工：`sessions` 表存业务字段（title / projectId / settings…），
 * JSONL 文件存对话树。leafId 由文件自身推导，不需要在表里冗余。
 *
 * 代价：两处存储没有共同事务。删除会话是「删表行 + unlink 文件」两步，中途崩溃会留下
 * 孤儿 .jsonl。刻意不做启动扫描兜底 —— 后果只是几个不再被引用的文本文件，
 * 既不影响正确性也不影响性能，不值得为它加一条全目录扫描的启动路径。
 */
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { JsonlSessionStorage, Session } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { createSessionTreeRegistry } from '@shuvix/agent-runtime'
import { getSessionsDir } from '../utils/paths'
import { createLogger } from '../logger'

const log = createLogger('SessionStorage')

/**
 * 会话文件读写专用的 ExecutionEnv。
 *
 * 与 AgentSession 里那个（cwd = 项目工作目录、供 systemPrompt 回调用）是两回事：
 * 这个只用来读写 sessions 目录下的 .jsonl，cwd 固定，全局一个足够。
 */
let fsEnv: NodeExecutionEnv | null = null
function getFsEnv(): NodeExecutionEnv {
  if (!fsEnv) fsEnv = new NodeExecutionEnv({ cwd: getSessionsDir() })
  return fsEnv
}

/** 某会话的转写文件绝对路径 */
export function sessionFilePath(sessionId: string): string {
  // sessionId 是 uuidv7，本身按时间有序 —— 无需 pi 默认布局里的时间戳前缀，
  // 也无需按 cwd 分目录（那是给 `SessionRepo.list(cwd)` 用的，我们不用）。
  return join(getSessionsDir(), `${sessionId}.jsonl`)
}

// ─── 共享缓存（内核在 @shuvix/agent-runtime 的 createSessionTreeRegistry） ───

const registry = createSessionTreeRegistry({
  open: async (sessionId) =>
    new Session(await JsonlSessionStorage.open(getFsEnv(), sessionFilePath(sessionId))),
  // 注意 pi 的 open() 校验 header cwd 非空而 create() 不校验 —— 空 cwd 会写出一个
  // 再也读不回来的文件，这里统一回落到 sessions 目录兜底。
  create: async (sessionId, cwd) =>
    new Session(
      await JsonlSessionStorage.create(getFsEnv(), sessionFilePath(sessionId), {
        cwd: cwd || getSessionsDir(),
        sessionId
      })
    ),
  exists: (sessionId) => existsSync(sessionFilePath(sessionId))
})

/**
 * 注册一条钉住判定 —— **可叠加**，任一为真即钉住。
 *
 * 刻意不是覆盖式 setter：钉住的来源不止一处（有根会话看 `agents.tracked`，聊天会话看
 * `botService.isActive`），而 registry 只收一个谓词。若让两边各调一次覆盖式 setter，
 * 后注册的会**静默吃掉**前一个，症状是「有些会话偶尔丢消息」——因为被逐出的 Session
 * 实例并不销毁，它还能继续往同一个 jsonl 追加，于是两个内存快照各写各的、消息静默分叉。
 *
 * 谓词会在每次新建缓存槽时对**每个槽**各调一次，所以必须同步、O(1)、纯内存。
 */
const pinPredicates: Array<(sessionId: string) => boolean> = []

export function addSessionTreePin(fn: (sessionId: string) => boolean): void {
  pinPredicates.push(fn)
  registry.setPinned((sessionId) => pinPredicates.some((p) => p(sessionId)))
}

/**
 * 取共享会话树；文件不存在时返回 null（不创建）。
 *
 * 读取路径（message.list / readSessionRunConfig …）用这个 ——
 * 打开一个从未发过消息的会话不该在磁盘上留下空文件。
 * 回滚（moveTo）也走这里：追加经共享实例，Agent 与读取端同步可见。
 */
export async function getSessionTree(sessionId: string): Promise<Session | null> {
  return await registry.get(sessionId)
}

/**
 * 取共享会话树，文件不存在则创建。
 *
 * 写路径（AgentSession 创建 / Agent 未建时的运行配置追加）用这个。
 *
 * @param cwd 首次创建时写进 header 的工作目录，仅作记录；已存在/已缓存时忽略。
 */
export async function ensureSessionTree(sessionId: string, cwd = ''): Promise<Session> {
  return await registry.ensure(sessionId, cwd)
}

/** 清空共享缓存 —— 仅供单测隔离（生产路径逐出走 deleteSessionFile / LRU） */
export function clearSessionTreeCacheForTests(): void {
  registry.clearForTests()
  // 谓词是叠加的，测试之间必须一并清掉，否则上一例注册的钉住会漏进下一例
  pinPredicates.length = 0
  registry.setPinned(() => false)
}

// ─── 运行配置：会话树是唯一事实源 ─────────────────────────────────
//
// provider / model / thinkingLevel / enabledTools 都不再有数据库列（v15 删除）。
// 读：沿当前分支取最后一条对应 change entry。写：直接往树上追加一条。
//
// 之所以在这里做而不是全走 harness：会话是**懒创建**的 —— 用户可以在从未发送过消息、
// Agent 尚未存在的会话上切模型。那时没有 harness 可用，但仍要能落下这次选择。

export interface SessionRunConfig {
  provider: string | null
  model: string | null
  thinkingLevel: string | null
  enabledTools: string[] | null
}

/**
 * 从会话树读出当前运行配置。文件不存在或树上没有对应 entry → 该项为 null（调用方回落默认）。
 *
 * 只看**当前分支**（getBranch），因此回退到旧分支后读到的是那条分支上的配置，
 * 与 pi 的 `deriveSessionContextState` 语义一致。注意不能用被压缩过滤后的 entry：
 * 早于压缩切点的 model_change 依然有效。
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

/**
 * 会话树写锁 —— 对同一会话的树写入串行化。
 *
 * **为什么必须有**：pi 的 `Session.appendMessage` 内部是
 * `parentId = await getLeafId()` → 构造 entry → `await appendEntry(entry)`，两次 await
 * 之间可被抢占。两个并发写者会读到**同一个 parentId**、写出两条同父 entry，后写的那条
 * 独占叶子 —— 先写的那条在 UI 与模型上下文里同时消失（文件里还躺着）。所以临界区必须
 * 整体包住「取叶子 + 追加」，只锁住 append 调用本身是不够的。
 *
 * 在此之前顺序是靠「一个会话一个运行时 + pi 的 phase 闸门」偶然成立的。聊天会话把两者
 * 都拆了：它没有根运行时，而配置 setter（`appendModelChange` 等）在无根会话下恒走这里
 * 的直接追加分支 —— 用户在 bot 回复的同时切一下模型就是两个写者。
 *
 * 树由锁体内取好、以形参交给回调：从签名上禁止调用方跨锁缓存 `Session` 引用
 * （LRU 逐出只删缓存槽、不销毁对象，缓存过的实例还能往已被 unlink 的 inode 里写）。
 *
 * **不要把 `moveTo` / `deleteSessionFile` 放进这把锁**：它们的纪律是「先 await
 * abortSession 再动树」，而 abortSession 自身要排空这把锁 —— 互相等就是死锁。
 */
const treeLocks = new Map<string, Promise<void>>()

// 持锁期间自钉住：写锁的存在本身就是「这个会话正在被写」。补上宿主计数覆盖不到的空档
// （bot 连续落多条 greeting 的间隙、以及压根没有计数的配置 setter）。
// 注意这是**纵深防御不是正确性来源** —— 不分叉的真正原因是「树在锁体内取」：
// 上一个写者释放锁时磁盘已经写完，下一个写者哪怕拿到重开的新实例，读到的叶子也是对的。
addSessionTreePin((sessionId) => treeLocks.has(sessionId))

export async function withSessionTreeLock<T>(
  sessionId: string,
  fn: (tree: Session) => Promise<T>,
  cwd = ''
): Promise<T> {
  const current = treeLocks.get(sessionId) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  const chained = current.then(() => next)
  treeLocks.set(sessionId, chained)

  await current
  try {
    return await fn(await ensureSessionTree(sessionId, cwd))
  } finally {
    release()
    if (treeLocks.get(sessionId) === chained) treeLocks.delete(sessionId)
  }
}

/**
 * 等这把锁排空 —— 把**此刻队列里**的写入跑完再返回。
 *
 * 措辞要精确：它不是禁写闸。drain 返回之后新来的写者照样能拿到锁，这一点弱于
 * `invalidateAgent`（那是解绑运行时 —— 没有实例就没有写者）。今天够用，是因为聊天会话
 * 的写者只有「正在处理的这条消息」；**M4′ 落地管线派发、出现长命写者之后，这个保证会在
 * 一个字都不改的情况下悄悄失效**，而它的三个调用点（clear / rollback / delete）都拿它
 * 当「动树之前的安全前提」。到那时需要的是一个真正的禁写位，不是这个函数。
 *
 * 与 `moveTo` / `deleteSessionFile` 同一条禁令：**不要从锁体内部调用它** —— 自己等自己。
 */
export async function drainSessionTreeLock(sessionId: string): Promise<void> {
  const pending = treeLocks.get(sessionId)
  // 没有在飞写入就直接返回：drain 不该有副作用。走 withSessionTreeLock 会 ensure 出一棵树，
  // 给「从未发过消息」的会话留下一个空 jsonl（按停止键就能复现），
  // 而 getSessionTree 立的规矩是「打开一个从未发过消息的会话不该在磁盘上留下空文件」
  if (!pending) return
  await pending.catch(() => {})
}

/** 往会话树追加一条 model_change（Agent 未创建时的写入路径） */
export async function appendModelChange(
  sessionId: string,
  provider: string,
  modelId: string
): Promise<void> {
  await withSessionTreeLock(sessionId, (tree) => tree.appendModelChange(provider, modelId))
}

/** 往会话树追加一条 thinking_level_change */
export async function appendThinkingLevelChange(
  sessionId: string,
  thinkingLevel: string
): Promise<void> {
  await withSessionTreeLock(sessionId, (tree) => tree.appendThinkingLevelChange(thinkingLevel))
}

/** 往会话树追加一条 active_tools_change */
export async function appendActiveToolsChange(
  sessionId: string,
  activeToolNames: string[]
): Promise<void> {
  await withSessionTreeLock(sessionId, (tree) => tree.appendActiveToolsChange(activeToolNames))
}

/** 删除某会话的转写文件（幂等），并逐出共享缓存 */
export function deleteSessionFile(sessionId: string): void {
  registry.evict(sessionId)
  const path = sessionFilePath(sessionId)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch (err) {
    log.warn(`删除会话文件失败 ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
