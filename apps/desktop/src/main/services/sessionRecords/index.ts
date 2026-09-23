/**
 * 会话记录 —— 会话这一行的**唯一出入口**。持久会话落 `sessions` 表，**内存会话**（ephemeral）只活在
 * 这里的内存表里、从不落库；调用方拿到的是同一套方法、同一种形状，不需要知道自己手里的是哪一种。
 * （「临时会话」在代码里另有所指 —— 不属于任何项目、用临时工作区的会话，与这里无关。）
 *
 * 为什么是这一层而不是 sessionService：会话行的读者遍布主进程 —— 内聚模块（knowledge / chromeBridge /
 * builtinMcp / memory）按分层规则不许引扁平 service，agentHost / agentSession / botService 又在
 * sessionService 的依赖图里（它们直连 DAO 正是为了破环）。放在 DAO 之上、一切 service 之下，
 * 谁都引得到、谁也不成环。`dao/sessionDao` 只许这里引（eslint `no-restricted-imports` 守着）。
 *
 * 内存会话的语义：
 *  - **点查点改**（findById / pick / pickSettings / update* / deleteById）与持久会话一模一样。
 *    内存里存的是与表行同形的 `SessionRow`（settings 是 JSON 文本），读出时照表行的解析口径走，
 *    所以「缺键回 null」「每次读到的都是新对象」这些细节两边一致；重复 id 的 insert 同样抛错；
 *  - **列表查询看不见它**（findAll / findByProjectId / findByProjectAndNotebookPath）：侧栏、清扫、
 *    按笔记本路径找会话都不该碰到一条内存会话 —— 它归开它的那个宿主（窗口）自己记账。唯一例外是
 *    findChildren：内存会话的子会话也是内存会话（sessionService.create 按父会话推定），删父会话要级联；
 *  - **不记活跃**：touchActive 对它是空操作；日历索引（sessionDayPromptService）跳过它；
 *  - **删了也记得它是内存会话**（wasEphemeral）：删除之后迟到的写入（模型切换、日历入账…）据此
 *    拒绝，而不是在磁盘上给一条从没落过盘的会话补出一个 `.jsonl` 或一行日历。
 *
 * 会话树（对话内容）的内存化不在这里：sessionStorage 的树注册表按 isEphemeral / wasEphemeral 分流。
 */
import { sessionDao } from '../../dao/sessionDao'
import type { Session, SessionSettings } from '../../dao/types'

/** 与表行同形：settings 以 JSON 文本存 */
type SessionRow = Omit<Session, 'settings'> & { settings: string }

/** 与 sessionDao 同口径：坏 JSON / 空值回空对象 */
function parseSettings(json: string | undefined | null): SessionSettings {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return {}
  }
}

function toRow(session: Session): SessionRow {
  return {
    id: session.id,
    title: session.title,
    // 表里这两列可空：undefined 落库即 NULL，读回是 null
    projectId: session.projectId ?? null,
    parentId: session.parentId ?? null,
    settings: JSON.stringify(session.settings ?? {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActiveAt: session.lastActiveAt
  }
}

function parseRow(row: SessionRow): Session {
  return { ...row, settings: parseSettings(row.settings) }
}

export class SessionRecords {
  /** 活着的内存会话：id → 表行形状 */
  private readonly ephemeral = new Map<string, SessionRow>()
  /** 已删除的内存会话 id（一个 uuid 一条，进程内不回收 —— 量级是「开过几个窗口」） */
  private readonly retired = new Set<string>()

  /** 这条会话是不是一条**活着的**内存会话（只在内存里、从不落库）。O(1)，会话树的钉住判定也用它 */
  isEphemeral(id: string): boolean {
    return this.ephemeral.has(id)
  }

  /** 这个 id 曾是一条内存会话、已被删除 —— 迟到的写入据此拒绝落盘 */
  wasEphemeral(id: string): boolean {
    return this.retired.has(id)
  }

  // ─── 列表查询：只有持久会话 ──────────────────

  /** 所有持久会话，按用户最后动手时间倒序。内存会话不在其中 */
  findAll(): Session[] {
    return sessionDao.findAll()
  }

  /** 某项目下的持久会话。内存会话不在其中 */
  findByProjectId(projectId: string): Session[] {
    return sessionDao.findByProjectId(projectId)
  }

  /** 项目内绑定了指定 md 文件的持久笔记本会话。内存会话不在其中 */
  findByProjectAndNotebookPath(projectId: string, notebookPath: string): Session | undefined {
    return sessionDao.findByProjectAndNotebookPath(projectId, notebookPath)
  }

  /**
   * 某会话的直接子会话（创建序）。内存会话的子会话同为内存会话（见 sessionService.create），
   * 所以父会话是哪种、就在哪一边找。
   */
  findChildren(parentId: string): Session[] {
    if (!this.ephemeral.has(parentId)) return sessionDao.findChildren(parentId)
    return [...this.ephemeral.values()]
      .filter((row) => row.parentId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(parseRow)
  }

  // ─── 点查 ──────────────────────────────────

  findById(id: string): Session | undefined {
    const row = this.ephemeral.get(id)
    return row ? parseRow(row) : sessionDao.findById(id)
  }

  /** 按需取字段；`settings` 解析成对象 */
  pick<K extends keyof Session>(id: string, fields: K[]): Pick<Session, K> | undefined {
    const row = this.ephemeral.get(id)
    if (!row) return sessionDao.pick(id, fields)
    const result: Record<string, unknown> = {}
    for (const field of fields) {
      result[field] = field === 'settings' ? parseSettings(row.settings) : row[field]
    }
    return result as Pick<Session, K>
  }

  /** 从 settings 里按键取值；**缺键回 null**（与表上 `settings -> '$.key'` 同口径） */
  pickSettings<K extends keyof SessionSettings>(
    id: string,
    keys: K[]
  ): Pick<SessionSettings, K> | undefined {
    const row = this.ephemeral.get(id)
    if (!row) return sessionDao.pickSettings(id, keys)
    const settings = parseSettings(row.settings) as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      result[key] = key in settings ? settings[key] : null
    }
    return result as Pick<SessionSettings, K>
  }

  // ─── 写 ────────────────────────────────────

  /**
   * 插入会话。`ephemeral` 为真时只进内存表，从不落库。
   * id 已被占用（任何一边，含已删除的内存会话）即抛错 —— 与表上的主键冲突同口径，
   * 也不让一条内存会话遮住一条同 id 的持久会话。
   */
  insert(session: Session, options?: { ephemeral?: boolean }): void {
    if (this.ephemeral.has(session.id) || this.retired.has(session.id)) {
      throw new Error(`session id ${session.id} is already taken by an in-memory session`)
    }
    if (!options?.ephemeral) return sessionDao.insert(session)
    if (sessionDao.pick(session.id, ['id'])) {
      throw new Error(`session id ${session.id} is already taken by a stored session`)
    }
    this.ephemeral.set(session.id, toRow(session))
  }

  /** 更新标题和账本时间（updatedAt）。不 bump lastActiveAt */
  updateTitle(id: string, title: string): void {
    const row = this.ephemeral.get(id)
    if (!row) return sessionDao.updateTitle(id, title)
    row.title = title
    row.updatedAt = Date.now()
  }

  /** 账本时间：只 bump updatedAt */
  touch(id: string): void {
    const row = this.ephemeral.get(id)
    if (!row) return sessionDao.touch(id)
    row.updatedAt = Date.now()
  }

  /** 用户在这条会话上动手：bump lastActiveAt，不动 updatedAt。**内存会话不记活跃**，空操作 */
  touchActive(id: string): void {
    if (this.ephemeral.has(id)) return
    sessionDao.touchActive(id)
  }

  /** 更新会话所属项目 */
  updateProjectId(id: string, projectId: string | null): void {
    const row = this.ephemeral.get(id)
    if (!row) return sessionDao.updateProjectId(id, projectId)
    row.projectId = projectId
    row.updatedAt = Date.now()
  }

  /**
   * 更新会话级配置（patch 语义：仅更新传入的字段，undefined 的键跳过，其余保留）。
   * 真有字段写入才 bump updatedAt；不 bump lastActiveAt。
   */
  updateSettings(id: string, patch: SessionSettings): void {
    const row = this.ephemeral.get(id)
    if (!row) return sessionDao.updateSettings(id, patch)
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return
    // 经一次 JSON 往返再合并：与落库的值同形（调用方事后改自己手里的对象，不会改到这里）
    const settings = parseSettings(row.settings) as Record<string, unknown>
    for (const [key, value] of entries) settings[key] = JSON.parse(JSON.stringify(value))
    row.settings = JSON.stringify(settings)
    row.updatedAt = Date.now()
  }

  /** 删除会话这一行。日历索引行由 sessionService.delete 显式清（FK CASCADE 未开） */
  deleteById(id: string): void {
    if (this.ephemeral.delete(id)) {
      this.retired.add(id)
      return
    }
    sessionDao.deleteById(id)
  }

  /** 清空内存会话（含已删除的记忆）—— 仅供单测隔离 */
  clearEphemeralForTests(): void {
    this.ephemeral.clear()
    this.retired.clear()
  }
}

export const sessionRecords = new SessionRecords()
