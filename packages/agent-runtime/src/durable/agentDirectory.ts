/**
 * agent 目录 —— 一条会话里「每个对话上的 agent 是谁」与「哪些对话是辅助工作」的同步缓存（P2-01）。
 *
 * 由 DurableSession 持有，两条输入：
 *  - **提交发布**（同步，在 Session 串行线上）：每次 `AgentStateDoc` 的写入都带着整份新值；每个新建对话
 *    的记录带着它的拥有者边。谁写了这些，缓存都跟着变 —— 同步读取永远是真值。
 *  - **打开时的扫描**：每个任务拥有的对话（PIN-03：不只是有活任务的那些 —— 同步查询没法按需去读，
 *    闲着的子 agent 之后再被唤起时不能顶着根的身份干活）的 `AgentStateDoc`，以及全部拥有者边。
 *
 * 身份：`kind: 'spawned'` 的对话 → 它的派生 agent 身份；记录写坏了 → 最小的派生身份（没有模型配置）
 * 并记一次警告 —— **绝不**认成根（PIN-04：安全主体与审查的防递归要靠它）。其余对话不在这里
 * （DurableSession 按锁现取根的身份）。
 *
 * 辅助工作（`dispatch: 'hook'`，宿主派发的 hook agent：起标题、权限审查）：按 `dispatch === 'hook'`
 * **宽松**地读（记录写坏了照样算，PIN-04），并按拥有者边向上继承（PIN-08）—— 辅助对话里的任务派出的
 * 对话同样是辅助工作。它们从不续跑、不算中断、不进运行状态镜像（见 DurableSession）。
 *
 * 拥有者边也按任务记一份（任务 → 它拥有的对话，P2-08 PIN-02）：宿主派发的后台锚任务本身住在根里，但它
 * 拥有的对话全是辅助工作时，DurableSession 同样不把它算进运行状态。
 *
 * fork 出来的对话（`document.copy`，没有值）不在这里处理：fork 派生 agent 的对话不是产品路径（回退只
 * fork 根 / 用户的当前对话，PIN-11），它们按根认人。
 */
import type {
  ConversationId,
  ConversationRecord,
  JsonObject,
  TaskId
} from '@earendil-works/pi-durable'
import type { RuntimeLogger } from '../types'
import {
  parseSpawnedAgentRecord,
  spawnedAgentIdentity,
  type AgentIdentity,
  type SpawnedAgentRecord
} from './agentRecord'

/** 只有派生 agent 记录才有的键（`kind` / `profileName` 与冻结的人设共用，不算） */
const RECORD_ONLY_KEYS = [
  'conversationId',
  'model',
  'thinkingLevel',
  'toolNames',
  'extensions',
  'sandboxed',
  'mcp',
  'skills',
  'createdAt',
  'agentId',
  'depth',
  'canSpawn',
  'dispatch',
  'parentConversationId',
  'ownerTaskId',
  'displayName',
  'description',
  'hook',
  'resultContract'
] as const

/** 两条解析出的记录是否相同（解析按固定次序建对象，JSON 文本相等即相同） */
function sameRecord(a: SpawnedAgentRecord, b: SpawnedAgentRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface SpawnedEntry {
  readonly identity: AgentIdentity
  /** undefined = 记录写坏了（只有最小身份） */
  readonly record: SpawnedAgentRecord | undefined
}

export interface AgentDirectoryDeps {
  sessionId: string
  logger: RuntimeLogger
}

export class AgentDirectory {
  /** 派生 agent 的对话 → 身份（与解析出的记录） */
  private readonly spawned = new Map<ConversationId, SpawnedEntry>()
  /** `dispatch === 'hook'` 的对话（宽松读） */
  private readonly hooks = new Set<ConversationId>()
  /** 任务拥有的对话 → 拥有它的任务所在的对话 */
  private readonly owners = new Map<ConversationId, ConversationId>()
  /** 任务 → 它拥有的对话（P2-08 PIN-02：锚任务的运行状态排除） */
  private readonly owned = new Map<TaskId, Set<ConversationId>>()

  constructor(private readonly deps: AgentDirectoryDeps) {}

  /** 一个对话的记录（创建它的提交、或打开时的扫描）：记下它的拥有者边 */
  observeConversation(record: ConversationRecord): void {
    if (record.owner === undefined) return
    this.owners.set(record.id, record.owner.conversationId)
    let conversations = this.owned.get(record.owner.taskId)
    if (conversations === undefined) {
      conversations = new Set()
      this.owned.set(record.owner.taskId, conversations)
    }
    conversations.add(record.id)
  }

  /**
   * 一个任务拥有的对话是不是**全都**是辅助工作（至少一条）—— 宿主派发的锚（P2-08 PIN-02）。一条对话都
   * 不拥有的任务（后台压缩之类）不算：它们照样让会话忙。
   */
  ownsOnlyAuxiliary(taskId: TaskId): boolean {
    const conversations = this.owned.get(taskId)
    if (conversations === undefined || conversations.size === 0) return false
    for (const conversationId of conversations) {
      if (!this.isAuxiliary(conversationId)) return false
    }
    return true
  }

  /** 一个对话的 `AgentStateDoc` 此刻的值（null / undefined = 文档没了） */
  observeAgentState(conversationId: ConversationId, value: JsonObject | null | undefined): void {
    if (value?.dispatch === 'hook') this.hooks.add(conversationId)
    else this.hooks.delete(conversationId)
    if (value === null || value === undefined || value.kind !== 'spawned') {
      this.spawned.delete(conversationId)
      return
    }
    const previous = this.spawned.get(conversationId)
    const record = parseSpawnedAgentRecord(value)
    if (record !== undefined) {
      // 无关的写入（日期、人设）照样带着整份文档发布：记录没变就留着原来的身份对象
      if (previous?.record !== undefined && sameRecord(previous.record, record)) return
      this.spawned.set(conversationId, { identity: spawnedAgentIdentity(record), record })
      return
    }
    const { profileName, agentId } = value
    this.spawned.set(conversationId, {
      identity: {
        profileName: typeof profileName === 'string' ? profileName : '',
        kind: 'spawned',
        ...(typeof agentId === 'string' && agentId.length > 0 ? { callerId: agentId } : {})
      },
      record: undefined
    })
    // 有记录字段却解析不了 = 写坏了：只在变成「写坏了」的那一刻警告一次（之后无关的写入照样带着这份
    // 坏记录发布）。只冻结了人设、还没有任何记录字段的派生对话照样按派生认人，但不算写坏
    const hasRecordFields = RECORD_ONLY_KEYS.some((key) => value[key] !== undefined)
    if (hasRecordFields && (previous === undefined || previous.record !== undefined)) {
      this.deps.logger.warn(
        `session ${this.deps.sessionId}: conversation ${conversationId} has a malformed spawned agent record; it acts as a spawned agent without a model`
      )
    }
  }

  /** 派生 agent 的身份（不是派生 agent 的对话 → undefined） */
  identity(conversationId: ConversationId): AgentIdentity | undefined {
    return this.spawned.get(conversationId)?.identity
  }

  /** 派生 agent 的记录（不是派生 / 写坏了 → undefined） */
  record(conversationId: ConversationId): SpawnedAgentRecord | undefined {
    return this.spawned.get(conversationId)?.record
  }

  /** 是不是辅助工作：自己是 hook agent，或拥有者链上有一个是（PIN-08） */
  isAuxiliary(conversationId: ConversationId): boolean {
    if (this.hooks.size === 0) return false
    const seen = new Set<ConversationId>()
    let current: ConversationId | undefined = conversationId
    while (current !== undefined && !seen.has(current)) {
      if (this.hooks.has(current)) return true
      seen.add(current)
      current = this.owners.get(current)
    }
    return false
  }
}
