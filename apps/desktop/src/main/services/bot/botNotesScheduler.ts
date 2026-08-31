/**
 * 笔记归纳的节流调度（设计 §8）。
 *
 * 笔记是**离线**的：bot 答完话之后、没人等着的时候，另起一次 `occasion: 'notes'` 的
 * invoke，让 `bot-notes` 阶段 agent 自己用 `read`/`edit` 就地改那份 md。这里只回答
 * 三个问题 —— 什么时候值得跑一次、跑的时候给它看哪些新材料、跑完记到哪儿。
 *
 * **双门槛**（距上次 ≥30min 且累计 ≥3 件值得记的事）：单看时间会在闲置会话上空转，
 * 单看件数会在一次密集对话里连跑好几次，而每次都是一整份笔记进上下文加一张询问卡。
 *
 * **检查点按会话记「最后已归纳到哪条 entry」**，而不是记一个全局时间戳：一个 bot 同时
 * 在好几个会话里说话，时间戳会把「B 会话刚说完的话」当成「A 会话已经归纳过的」。
 * 检查点**只在成功之后前进** —— 失败的那一轮下次会看到同样的材料，不必补偿。
 *
 * 状态落 `~/.shuvix/bots/.notes-state.json`（与 bot md 同目录、点号开头，不被注册表扫描）。
 * 进程重启后从这里接着算，所以「重启补扫」不是另一条路径，就是同一个检查点。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getDefaultBotsDir } from '../../utils/paths'
import { writeFileAtomic } from '../../utils/atomicWrite'
import { createLogger } from '../../logger'

const log = createLogger('BotNotes')

/** 距上次归纳至少这么久 */
export const NOTES_MIN_INTERVAL_MS = 30 * 60 * 1000
/** 攒够这么多件值得记的事 */
export const NOTES_MIN_EVENTS = 3

interface BotNotesState {
  /** 上次成功归纳的时刻 */
  lastRunAt: number
  /** 自上次归纳以来攒了几件 */
  pending: number
  /** sessionId → 该会话最后已归纳的 entry id（空串 = 还没归纳过这个会话） */
  sessions: Record<string, string>
}

type StateFile = Record<string, BotNotesState>

function emptyState(): BotNotesState {
  return { lastRunAt: 0, pending: 0, sessions: {} }
}

export interface NotesSchedulerDeps {
  /** 真正跑一次归纳；返回是否成功（失败则检查点不前进） */
  runNotes: (
    botName: string,
    dirty: Array<{ sessionId: string; sinceEntryId: string }>
  ) => Promise<boolean>
  now?: () => number
}

/**
 * 调度器本身不认识 workflow、也不读会话树 —— 那两件事经 deps 注入。
 * 这样「什么时候该跑」可以用假时钟单测，不必拉起半个宿主。
 */
export class BotNotesScheduler {
  private state: StateFile = {}
  private loaded = false
  /** 正在跑的 bot：同一个 bot 的第二次触发不重复派发（跨会话串行由 lane 兜底，这里省一次空转） */
  private readonly running = new Set<string>()

  constructor(private readonly deps: NotesSchedulerDeps) {}

  private get file(): string {
    return join(getDefaultBotsDir(), '.notes-state.json')
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** 懒加载：坏文件当成空状态（笔记调度不该因为一份坏 JSON 就整个停摆） */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown
      if (typeof raw === 'object' && raw !== null) this.state = raw as StateFile
    } catch (e) {
      log.warn('笔记状态读取失败，按空状态继续:', e)
    }
  }

  private save(): void {
    try {
      writeFileAtomic(this.file, JSON.stringify(this.state, null, 2))
    } catch (e) {
      log.warn('笔记状态写入失败:', e)
    }
  }

  private of(botName: string): BotNotesState {
    this.load()
    const cur = this.state[botName] ?? emptyState()
    this.state[botName] = cur
    return cur
  }

  /**
   * 记一件「值得归纳的事」（一次任务、或意图段标了 memorable 的一次回复）。
   *
   * 只记账不落盘：一次密集对话会连着来好几件，每件都写一次盘不值当 —— 真正需要持久的是
   * 检查点，而它只在归纳成功时前进（那时会落盘）。进程崩了最多丢掉「攒了几件」这个计数，
   * 下次对话很快会重新攒够。
   */
  note(botName: string, sessionId: string): void {
    const st = this.of(botName)
    st.pending += 1
    if (!(sessionId in st.sessions)) st.sessions[sessionId] = ''
  }

  /** 两个门槛都过了才值得跑 */
  private due(botName: string): boolean {
    const st = this.of(botName)
    return st.pending >= NOTES_MIN_EVENTS && this.now() - st.lastRunAt >= NOTES_MIN_INTERVAL_MS
  }

  /**
   * 到点就跑（没到点静默返回）。`force` 供退出前 flush 用 —— 那一刻门槛没有意义，
   * 攒着的东西再不写就永远没有下一次了。
   */
  async maybeRun(botName: string, force = false): Promise<void> {
    const st = this.of(botName)
    if (!st.pending) return
    if (!force && !this.due(botName)) return
    if (this.running.has(botName)) return

    this.running.add(botName)
    const dirty = Object.entries(st.sessions).map(([sessionId, sinceEntryId]) => ({
      sessionId,
      sinceEntryId
    }))
    try {
      const ok = await this.deps.runNotes(botName, dirty)
      if (!ok) return
      // **只在成功之后前进**：失败的那一轮下次会看到同样的材料
      st.lastRunAt = this.now()
      st.pending = 0
      this.save()
    } catch (e) {
      log.warn(`笔记归纳异常 (${botName}):`, e)
    } finally {
      this.running.delete(botName)
    }
  }

  /** 归纳成功后由宿主回填「这个会话归纳到哪条了」 */
  advance(botName: string, checkpoints: Record<string, string>): void {
    const st = this.of(botName)
    for (const [sessionId, entryId] of Object.entries(checkpoints)) {
      if (entryId) st.sessions[sessionId] = entryId
    }
    this.save()
  }

  /**
   * bot 改名：把状态整条搬过去。
   *
   * 幂等：新名字已经有状态就不覆盖（改名迁移做了一半重来时，后写的一方赢会把已经跑过的
   * 归纳记录抹掉，于是同一批材料被归纳两遍）。
   */
  rename(oldName: string, newName: string): void {
    this.load()
    const from = this.state[oldName]
    if (!from || this.state[newName]) return
    this.state[newName] = from
    delete this.state[oldName]
    this.save()
  }

  /** 会话被删：它的检查点没有意义了，留着只会让状态文件无限长 */
  forgetSession(sessionId: string): void {
    this.load()
    let touched = false
    for (const st of Object.values(this.state)) {
      if (sessionId in st.sessions) {
        delete st.sessions[sessionId]
        touched = true
      }
    }
    if (touched) this.save()
  }

  /** 退出前 flush：所有攒着东西的 bot 各跑一次，忽略门槛 */
  async flushAll(): Promise<void> {
    this.load()
    const names = Object.keys(this.state).filter((n) => this.state[n].pending > 0)
    for (const name of names) await this.maybeRun(name, true)
  }

  /** 仅供测试与设置页：这个 bot 此刻攒了多少、上次什么时候跑的 */
  peek(botName: string): { pending: number; lastRunAt: number; sessions: number } {
    this.load()
    // **不走 `of()`**：那个会为未知名字种一条空状态，于是「看一眼」也能让状态文件长出
    // 一个从没归纳过的 bot
    const st = this.state[botName] ?? emptyState()
    return {
      pending: st.pending,
      lastRunAt: st.lastRunAt,
      sessions: Object.keys(st.sessions).length
    }
  }
}
