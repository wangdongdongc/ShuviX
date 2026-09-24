/**
 * 提示片段（Prompt fragments）—— 多个档案共用、但不属于任何一个档案的提示段落。
 *
 * 与 `builtinAgents/md/` 的区别是归属：那里一份 md 就是一个 agent 的全部人格，
 * 这里一份 md 是一段**能力说明**，由若干档案各自在正文里用一行占位符引入。
 * 二者同样以 md 维护、同样 `?raw` 内联、同样一语言一文件按整份回退 —— 一页提示散文
 * 写进 locale JSON 不可评审，这条规矩两边一致。
 *
 * 取值时机是**创建期**（`{{shuvix:*}}` 变量表），不是档案构建期：这样用户自己的
 * `~/.shuvix/agents/work.md` 覆盖了基座档案之后，只要正文里留着那行占位符就照样拿到
 * 同一份说明 —— 覆盖人格不该顺带丢掉一项能力。语言由宿主传入（宿主是界面语言的权威）。
 */
import { pickLocalizedSource } from '../../subagent/builtinAgents/spec'

import visualGuideEn from './visual-guide.md?raw'
import visualGuideZh from './visual-guide.zh.md?raw'
import visualGuideJa from './visual-guide.ja.md?raw'

const VISUAL_GUIDE_SOURCES = { en: visualGuideEn, zh: visualGuideZh, ja: visualGuideJa }

/**
 * **作图的契约与手艺全在 `builtin:drawing` 技能里，系统提示只留「先加载」**（2026-09-24，用户裁决，
 * 照 Claude 自己 `show_widget` + `read_me` 的模式）。从前 svg 契约、框箭头预算常驻，手艺段在技能
 * 不在架时也常驻 —— 理由是围栏没有「画之前」可以挂一句「先加载」。换成「本会话第一次画图前加载，
 * 之后一直留在上下文里」之后，这个代价只在每场会话的第一张图付一次；赌的是模型会照做（实测画数据图
 * 前本来就会主动加载）。**技能不在架时整份说明不出**：指一个拿不到的技能是死路，而契约只写一份在
 * 技能里，不在提示与技能之间同步两份。
 *
 * 片段里的五段，各由一对界桩 `<!-- shuvix:<name>-start -->` … `<!-- shuvix:<name>-end -->` 圈出：
 *
 *  - `carrier` —— **这张图去哪儿**：聊天里是回复的一部分。一份片段两个出口：{{shuvix:visualGuide}}
 *    带载体，{{shuvix:visualCraft}}（笔记本 / 协同编辑：图往文件里画）不带 —— 载体那段对它们是死路。
 *  - `adopt`（嵌在 carrier 里）—— 改图走 `artifact adopt`。只给手里真有 `artifact` 工具的 agent。
 *  - `load` —— 「本会话第一张图之前先加载技能」。两个出口都有；技能在架才会走到这里。
 *  - `interactive` —— ```interactive 交互块：什么时候用，以及「写之前先读技能里的 interactive.md」。
 *    只属于聊天：笔记本不渲染它，Chrome 侧栏跑不起来它（扩展页 CSP 禁内联脚本）。所以既要带载体，
 *    又要宿主说这个 agent 的回复会落在能跑它的地方。
 *  - `interactive-adopt`（嵌在 interactive 里）—— 改一块交互块走 `artifact adopt` + `edit`。只给手里有
 *    `artifact` 的 agent；它得常驻而不是写进技能：「改一下范围」那一轮模型不会想到回头再读技能页。
 *
 * 常驻部分只点一次技能的全名（`builtin:drawing`，在 load 段）：交互段说「那个作图技能」，不重复点名。
 */
const SECTION_TAG = (name: string, edge: 'start' | 'end'): string =>
  `<!-- shuvix:${name}-${edge} -->`

/** keep：去掉界桩、留下内容；否则连同内容整段换成 replacement（缺省为空） */
function applySection(guide: string, name: string, keep: boolean, replacement = ''): string {
  const startTag = SECTION_TAG(name, 'start')
  const endTag = SECTION_TAG(name, 'end')
  const start = guide.indexOf(startTag)
  const end = guide.indexOf(endTag)
  // 界桩缺失时原样返回：片段是手维护的 md，少一个标记不该让整段提示消失
  if (start < 0 || end < start) return guide
  const tail = guide.slice(end + endTag.length)
  if (keep) return guide.slice(0, start) + guide.slice(start + startTag.length, end) + tail
  return guide.slice(0, start) + replacement + tail
}

/**
 * 前两个选项描述**这一个 agent 手里有什么**，由宿主按创建时的工具名单判定（见 PromptVarsCtx.toolNames）
 * —— 不是「这个宿主支持什么」。按宿主判就会出现名单上没有、提示里却指着的死路：派发出来的 agent
 * 被告知去加载一个它货架上没有的技能，扩展端被教一个它调不到的 `adopt`。缺省即「没有」。
 * 第三个（`interactive`）是例外，理由见它自己的注释；缺省同样是「没有」。
 */
export interface VisualGuideOptions {
  /** 技能货架上有 `builtin:drawing`（档案点了名，且没在侧栏停用）→ 才有这份说明；没有就整份不出 */
  drawingSkill?: boolean
  /** 工具表里有 `artifact` → 教改图走 adopt（只对带载体的那一档有意义） */
  artifact?: boolean
  /**
   * 这个 agent 的回复会显示在能运行 ```interactive 的地方（桌面的会话；不是 Chrome 侧栏的标签页
   * 会话，也不是把回复当工具结果交回去的派生 agent）→ 教交互块。这一项确实是宿主判的，不是
   * 工具名单 —— 交互块不需要任何工具，它能不能跑只取决于回复在哪儿显示。（技能在架是整份说明的
   * 前提，这里不必再单独要求。）
   */
  interactive?: boolean
}

/**
 * `{{shuvix:visualGuide}}` 的取值 —— 聊天里的内联作图：```svg 围栏是什么、先加载作图技能、改图走 adopt，
 * 以及（回复落在能跑它的地方时）交互块。技能不在架时为空串（占位符处整块消失）。
 *
 * 自含块：值自带小标题，可直接嵌在正文任意位置。**围栏本身**刻意不做宿主分支 —— 渲染在
 * chat-ui 里（两端共用同一个 CodeBlock），两端都成立。
 */
export function renderVisualGuide(
  language: string | undefined,
  options?: VisualGuideOptions
): string {
  return render(language, options ?? {}, true)
}

/**
 * `{{shuvix:visualCraft}}` 的取值 —— **同一份片段去掉载体那一段**：只剩「先加载作图技能」。
 *
 * 给的是「图往文件里画」的档案（笔记本 / 协同编辑：```svg 围栏在 markdown live preview 里就地渲染，
 * 见 atomic-editor 的 svg-blocks）。载体那段讲的是聊天的规矩 —— 图是回复的一部分、改图走
 * `artifact adopt` —— 对着一个正在编辑文件的 agent 讲那些，是教它一条走不通的路。载体框架天然
 * 属于各档案自己的人格正文，由档案自己写。
 */
export function renderVisualCraft(
  language: string | undefined,
  options?: Pick<VisualGuideOptions, 'drawingSkill'>
): string {
  // interactive 不传：笔记本的 live preview 不渲染交互块，教它就是教一条死路
  return render(language, { drawingSkill: options?.drawingSkill }, false)
}

function render(
  language: string | undefined,
  options: VisualGuideOptions,
  carrier: boolean
): string {
  // 契约与手艺只在技能里：技能不在架，这份说明就整份不出（见文件头）
  if (options.drawingSkill !== true) return ''
  let guide = pickLocalizedSource(VISUAL_GUIDE_SOURCES, language)
  // 先里后外：adopt 嵌在 carrier 里，外层整段删掉时里层的界桩也就一起走了
  guide = applySection(guide, 'adopt', carrier && options.artifact === true)
  guide = applySection(guide, 'carrier', carrier)
  guide = applySection(guide, 'load', true)
  guide = applySection(guide, 'interactive-adopt', options.artifact === true)
  guide = applySection(guide, 'interactive', carrier && options.interactive === true)
  return guide.replace(/\n{3,}/g, '\n\n').trim()
}
