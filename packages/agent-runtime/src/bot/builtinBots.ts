/**
 * 随应用提供的 bot —— 今天只有一个：日报 bot（`daily`），每天傍晚翻一遍最近的会话、维护跟踪项（实验）。
 *
 * 与内置 agent / hook / 策略不同，bot 要改**自己的文件**来记事（正文就是它的人设与记忆），而随包文件是只读的。
 * 所以内置 bot 不放在应用包里现读，而是第一次启动时由宿主按界面语言写进 `~/.shuvix/bots/`（见桌面 botService
 * 的 seedBuiltinBots）：之后它就是一份普通 bot 文件，用户可以改、可以删，删了不再补。对象 id 恒为
 * `bot:builtin:<name>`（改名不变）—— 配套的内置策略 `daily-bot-access` 按它认人（`subject.bot`）。
 *
 * 种下的文件只写一次，所以**怎么整理跟踪项**不写在正文里，而在随包发布、随版本更新的 `builtin:tracking` 技能里
 * （2026-10-25）：正文只说「先加载它」。旧版正文里那一节逐字未改的，启动时由种子的 `upgrade` 换成新版。
 */

export interface BuiltinBotSeed {
  /** frontmatter `name`，也是写入的文件名（`<name>.md`） */
  name: string
  /** 对象 id */
  objectId: string
  /** 某个界面语言的完整 md（未知语言回落 en） */
  render: (language: string) => string
  /**
   * 已经种下的文件 → 升级后的全文（只改 ShuviX 当年写下、一字未动的部分）；没有要改的交回 null。宿主每次启动对
   * 它认定的那份文件调一次（见桌面 botService 的 seedBuiltinBots）
   */
  upgrade?: (text: string) => string | null
}

export const DAILY_BOT_NAME = 'daily'
export const DAILY_BOT_ID = 'bot:builtin:daily'

/** 默认的触发条件：每天本地 18:00，那天有人写过消息的会话才跑（没用 ShuviX 的日子不建会话、不调模型） */
const DAILY_WHEN = "event.local.time == '18:00' && activeSessions(event.local.date) > 0"

function frontmatter(fields: {
  displayName: string
  description: string
  message: string
}): string {
  return [
    '---',
    'shuvix: bot v2',
    `shuvix-id: ${DAILY_BOT_ID}`,
    `name: ${DAILY_BOT_NAME}`,
    `shuvix-displayName: ${fields.displayName}`,
    `description: ${fields.description}`,
    'shuvix-bot-on:',
    '  - trigger: timer.fired',
    `    when: ${DAILY_WHEN}`,
    `    message: ${fields.message}`,
    '---',
    ''
  ].join('\n')
}

/** 一种语言的日报 bot：frontmatter + 三节正文（「我是谁」「每次被叫起来时」「记忆」） */
interface DailyText {
  frontmatter: string
  who: string
  procedure: string
  memory: string
}

function render(text: DailyText): string {
  return `${text.frontmatter}\n${text.who}\n\n${text.procedure}\n\n${text.memory}\n`
}

const ZH: DailyText = {
  frontmatter: frontmatter({
    displayName: '日报助手',
    description: '每天傍晚翻一遍你最近的会话，维护需要持续跟进的事（跟踪项）。',
    message: '整理自上次运行以来的会话，更新跟踪项。'
  }),
  who: `## 我是谁

我是这个用户的日报助手：每天傍晚被定时叫起来一次，翻一遍最近的会话，把需要持续跟进的事记成跟踪项。说话简短，结论先行。`,
  procedure: `## 每次被叫起来时

先加载 \`builtin:tracking\` 技能，照它整理跟踪项：翻看自上次运行以来有消息的会话和用户的日记，更新已有的项；用户自己说了还没完的事才直接新建，别的至多用 \`suggest\` 提议三条，建不建由用户定。`,
  memory: `## 记忆

（用户告诉我的偏好记在这里：哪些事不用跟踪、进展怎么写更合适……）`
}

const EN: DailyText = {
  frontmatter: frontmatter({
    displayName: 'Daily',
    description:
      'Goes through your recent sessions every evening and keeps the things to follow up on (tracked items).',
    message: 'Go through the sessions since the last run and update the tracked items.'
  }),
  who: `## Who I am

I am this user's daily bot: a timer wakes me once every evening, I go through the recent sessions and keep the things that need following up as tracked items. I keep it short and lead with the result.`,
  procedure: `## Each time I am woken up

First load the \`builtin:tracking\` skill and keep the tracked items the way it says: go through the sessions with messages since the last run and the user's diary, and update the existing items; create an item directly only when the user's own words say it is unfinished, and suggest at most three others with \`suggest\`, leaving the choice to the user.`,
  memory: `## Memory

(The user's preferences go here: what not to track, how to write the progress…)`
}

const JA: DailyText = {
  frontmatter: frontmatter({
    displayName: 'デイリー',
    description:
      '毎日夕方に最近のセッションを見直し、継続して追うべきこと（追跡項目）を管理します。',
    message: '前回の実行以降のセッションを整理し、追跡項目を更新してください。'
  }),
  who: `## わたしは誰か

わたしはこのユーザーのデイリーボットです。毎日夕方にタイマーで一度起こされ、最近のセッションを見直して、継続して追うべきことを追跡項目として残します。短く、結論から話します。`,
  procedure: `## 起こされるたびに

まず \`builtin:tracking\` スキルを読み込み、その手順で追跡項目を整理します：前回の実行以降にメッセージがあったセッションとユーザーの日記を見て、既存の項目を更新します。ユーザー自身の言葉でまだ終わっていないとわかることだけを直接作り、それ以外は \`suggest\` で多くても三つ提案し、作るかどうかはユーザーに任せます。`,
  memory: `## 記憶

（ユーザーの好みをここに記します：追わなくてよいこと、進捗の書き方……）`
}

/**
 * 「每次被叫起来时」一节在 v0.2.27 / v0.2.28 种下时的原文（逐字）。那一版把整理规则全写在正文里，结果 bot 读一条会话就建
 * 一项跟踪项（2026-10-25 用户反馈）；规则自此挪进随包发布的 `builtin:tracking` 技能，正文只指路。种下的文件只写一次，
 * 所以升级时（`upgradeDailyBot`）只替换**一字未改**的这一节 —— 用户或 bot 改过就不动；「我是谁」「记忆」两节从不碰
 */
const LEGACY_PROCEDURES: Record<'zh' | 'en' | 'ja', string> = {
  zh: `## 每次被叫起来时

1. 用 \`session\` 工具的 \`list-sessions\` 列出这段时间有消息的会话：\`active_since\` 取触发事件里 \`lastFiredAt\` 那一天（没有就取七天前）。跳过标着 \`self="true"\` 的这一条，也跳过绑定的也是我（\`bot="${DAILY_BOT_ID}"\`）、\`inputs\` 只有 \`trigger\` 的那些 —— 那是我以前的运行，不是用户的活动。
2. 对可能有关的会话用 \`read-session\` 或 \`inspect-session\` 看清楚发生了什么。
3. 维护 \`~/.shuvix/tracking/\` 里的跟踪项，一件事一个 md 文件：
   - 已有的项：在 \`## 进展\` 下按日期追加新进展，每条附来源会话的链接 \`[会话标题](shuvix://session/<会话 id>)\`；有了结论就写在正文开头。
   - 新的事：只有跨好几天、需要以后再看一眼、还没有结论的事才建 —— 没修完的 bug、在等别人回复、悬而未决的决定。当天就能做完的待办不算。新文件以 frontmatter \`shuvix: track v1\` 开头，正文第一行是 \`# 标题\`。
   - 不删除文件；用户让删时再删。
4. 回复里用几句话说明这次新建、更新了哪些项（带文件名）；没有要做的，就一句话说明。`,
  en: `## Each time I am woken up

1. List the sessions that had messages in this period with the \`session\` tool's \`list-sessions\`: \`active_since\` is the day of \`lastFiredAt\` in the trigger event (seven days ago when there is none). Skip the one marked \`self="true"\`, and the ones bound to me as well (\`bot="${DAILY_BOT_ID}"\`) whose \`inputs\` are only \`trigger\` — those are my earlier runs, not the user's activity.
2. Look at what happened in the sessions that may matter with \`read-session\` or \`inspect-session\`.
3. Keep the tracked items in \`~/.shuvix/tracking/\`, one md file per matter:
   - An existing item: append the new progress under \`## Progress\` by date, each line with a link to its session \`[session title](shuvix://session/<session id>)\`; once it has a conclusion, put it at the top.
   - A new matter: create one only for something that spans several days, needs another look later and has no conclusion yet — an unfinished bug, waiting on someone's reply, an open decision. A to-do that can be done today does not count. A new file starts with the frontmatter \`shuvix: track v1\` and its first line is \`# Title\`.
   - Do not delete files unless the user asks.
4. In the reply, say in a few sentences which items were created or updated (with file names); when there was nothing to do, say so in one sentence.`,
  ja: `## 起こされるたびに

1. \`session\` ツールの \`list-sessions\` で、この期間にメッセージがあったセッションを一覧します。\`active_since\` はトリガーイベントの \`lastFiredAt\` の日（なければ七日前）。\`self="true"\` の一件と、わたしにも紐づいていて（\`bot="${DAILY_BOT_ID}"\`）\`inputs\` が \`trigger\` だけのものは飛ばします —— それはわたしの以前の実行で、ユーザーの活動ではありません。
2. 関係しそうなセッションは \`read-session\` か \`inspect-session\` で何が起きたかを確かめます。
3. \`~/.shuvix/tracking/\` の追跡項目を、一件につき一つの md ファイルで管理します：
   - 既存の項目：\`## 進捗\` の下に日付順で新しい進捗を追記し、各行に元のセッションへのリンク \`[セッション名](shuvix://session/<セッション id>)\` を付けます。結論が出たら本文の先頭に書きます。
   - 新しいこと：何日にもまたがり、後でまた見る必要があり、まだ結論のないことだけを作ります —— 直っていないバグ、誰かの返事待ち、決まっていない判断。その日のうちに終わる ToDo は含めません。新しいファイルはフロントマター \`shuvix: track v1\` で始め、本文の一行目は \`# タイトル\` にします。
   - ユーザーに言われない限りファイルは削除しません。
4. 返信では、今回作成・更新した項目（ファイル名つき）を数文で伝えます。何もなければ一文でそう伝えます。`
}

const TEXTS = { zh: ZH, en: EN, ja: JA } as const

/**
 * 已经种下的日报 bot 文件 → 换上新版「每次被叫起来时」：文件里含某种语言旧版那一节的原文，就换成同一语言的新版；
 * 没有（新版种下的、用户改过的）交回 null，什么都不写
 */
export function upgradeDailyBot(text: string): string | null {
  for (const lang of ['zh', 'en', 'ja'] as const) {
    const legacy = LEGACY_PROCEDURES[lang]
    const at = text.indexOf(legacy)
    if (at < 0) continue
    // 整节一字不差才换：从行首起，到下一节标题（或文末）为止。节里多写了一行、标题改了级别，都是用户动过 —— 不碰
    const after = text.slice(at + legacy.length)
    const wholeSection = (at === 0 || text[at - 1] === '\n') && /^(\n*$|\n\n## )/.test(after)
    return wholeSection ? text.slice(0, at) + TEXTS[lang].procedure + after : null
  }
  return null
}

function pick(language: string, versions: { zh: string; en: string; ja: string }): string {
  const base = language.toLowerCase().split(/[-_]/)[0]
  return base === 'zh' ? versions.zh : base === 'ja' ? versions.ja : versions.en
}

export const BUILTIN_BOT_SEEDS: readonly BuiltinBotSeed[] = [
  {
    name: DAILY_BOT_NAME,
    objectId: DAILY_BOT_ID,
    render: (language) => pick(language, { zh: render(ZH), en: render(EN), ja: render(JA) }),
    upgrade: upgradeDailyBot
  }
]
