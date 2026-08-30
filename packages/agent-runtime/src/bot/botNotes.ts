/**
 * bot md 的**笔记区** —— 一条分界线，线以下是 bot 自己维护的散文。设计见 docs/bot-design.md §4.4。
 *
 *     你是项目助理。（人设散文…）
 *
 *     <!-- shuvix:bot-notes -->
 *
 *     ## 关于这个用户
 *     偏好 pnpm；讨论设计时习惯先看先例再拍板。
 *
 *     ## 在做的事
 *     把 bot 管线从 TS 编排改成 workflow md。
 *
 * 三条设计裁决，改这个文件前先读：
 *
 *  1. **笔记没有自己的语法**。线以下是普通 markdown：章节由 bot 按内容自己起名（用户偏好、
 *     项目约定、在做的事、上次做完的…），没有条目锚点、没有 slug、没有 pinned/日期字段。
 *     用户打开 bot md 时读到的就是一篇散文，不需要理解任何机器格式 —— 这正是不做条目化的
 *     全部理由。相应地，**写入是整段重写**而不是条目级增删：合并章节、改名、重组是散文的
 *     自然编辑方式，条目化只会让它们变笨拙。
 *
 *  2. **一条起始线，到文件尾为止**。不做成对围栏：笔记天然在文末，一条分界线就够了，
 *     而且这一下消掉了整类异常（开而未闭、闭在开前、多个闭锚点）。用户想给 bot 留个条，
 *     在文件底下写就是了。
 *
 *  3. **这条线是组织性的，不是权限墙**。笔记段拿的是普通文件工具（`read`/`edit`），
 *     它改得动线以上的人设 —— 用户说「你以后扮演…」时本来就该改得动。线的作用是：
 *     让人一眼看出哪半边是 bot 自己写的、让笔记段知道往哪写、让门控段能只取一小片而不是
 *     整篇。「别顺手动人设」是写在 bot-notes 提示词里的**纪律**，不是这里的机制。
 *
 * 本模块**只读不写**：笔记的日常维护由 `bot-notes` 阶段 agent 用普通 `edit` 工具就地完成
 * （它有 `read`/`edit`，见那份 md），宿主没有、也不需要程序化的笔记写路径 —— 这正是
 * 「先用简单方式实现」的落点。这里剩下的唯一职责是**把正文切成两半**，供解析器判定
 * 「人设得有东西」、供门控段按预算取笔记片、供设置页显示用量。
 *
 * 导出函数**恒不抛**：笔记是状态不是定义，它的任何结构异常都只记 anomaly，绝不让整份
 * bot 文件非法（见 botFile 头注释）。
 */

/** 笔记区的起始分界线（允许尾随说明文字，为将来的属性位留活口） */
export const BOT_NOTES_MARKER = '<!-- shuvix:bot-notes -->'

/**
 * 分界线判别：标记名之后必须是空白或注释终止符 —— 既放行属性位与无空格写法
 * （`<!--shuvix:bot-notes-->`），又挡住相邻词（`bot-notesish`）。
 * 用 `(?![\w-])` 是错的：`-->` 的第一个 `-` 会被它一并挡掉。
 */
const MARKER_RE = /^<!--\s*shuvix:bot-notes(?=\s|-->)[^\n>]*-->[ \t]*$/

export interface BotNotesSplit {
  /** 分界线之前的正文 —— 人设，用户所有，agent 永不改写 */
  persona: string
  /** 分界线之后的散文（已 trim）；无分界线为 null */
  notes: string | null
  /** 结构诊断；**恒不影响文件合法性** */
  anomalies: string[]
}

interface MarkerHit {
  /** 分界线行首在被扫描字符串里的下标 */
  start: number
  /** 分界线行末之后（下一行行首）的下标 */
  after: number
}

/**
 * 定位分界线（行首、跳过围栏代码块）。多条时取**第一条** —— 后面的都算笔记内容，
 * 因为把更多文本归给笔记、更少归给人设，是两类错误里代价小的那一类：
 * 「bot 写的字漏进人设」等于让它改写自己的设定，「用户散文被当成笔记」只是显示错位。
 */
function locateMarker(text: string): { hit: MarkerHit | null; anomalies: string[] } {
  const scanned = scanMarkers(text, true)
  // 人设里有**未闭合**的围栏时，围栏跟踪会把其后的一切都当代码 —— 分界线从此不可见，
  // 于是 split 把 bot 写的笔记全并进人设（self-narrative 污染），而 splice 每轮改写都
  // 走「新建」分支再**追加**一条分界线（笔记是每轮对话后重写的，这是热路径）。
  // 开而未闭的文档本就没有正解，两害相权：放弃围栏跟踪重扫一遍，让写入恒是替换。
  if (!scanned.openFence) return { hit: scanned.hit, anomalies: scanned.anomalies }
  const relaxed = scanMarkers(text, false)
  return { hit: relaxed.hit, anomalies: relaxed.anomalies }
}

function scanMarkers(
  text: string,
  trackFences: boolean
): { hit: MarkerHit | null; anomalies: string[]; openFence: boolean } {
  const anomalies: string[] = []
  let hit: MarkerHit | null = null
  let fence: string | null = null
  let offset = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const open = trackFences ? /^(`{3,}|~{3,})/.exec(line) : null
    const wasInFence = fence !== null
    if (open) {
      if (fence === null) fence = open[1]
      else if (line.startsWith(fence)) fence = null
    }
    const inFence = wasInFence || open !== null
    if (!inFence && MARKER_RE.test(line)) {
      if (hit === null)
        hit = { start: offset, after: Math.min(offset + rawLine.length + 1, text.length) }
      else anomalies.push('more than one notes marker — the first one starts the notes')
    }
    offset += rawLine.length + 1
  }
  return { hit, anomalies, openFence: fence !== null }
}

/**
 * 把正文（`splitFrontmatter` 的 body）切成人设与笔记。纯函数、恒不抛。
 * 无分界线时 `notes` 为 null，整段正文都是人设。
 */
export function splitBotNotes(body: string): BotNotesSplit {
  const { hit, anomalies } = locateMarker(body)
  if (!hit) return { persona: body, notes: null, anomalies }
  return {
    persona: body.slice(0, hit.start),
    notes: body.slice(hit.after).trim(),
    anomalies
  }
}
