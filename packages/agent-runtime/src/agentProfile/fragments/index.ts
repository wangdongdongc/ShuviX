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
import visualSkillHintEn from './visual-skill-hint.md?raw'
import visualSkillHintZh from './visual-skill-hint.zh.md?raw'
import visualSkillHintJa from './visual-skill-hint.ja.md?raw'

const VISUAL_GUIDE_SOURCES = { en: visualGuideEn, zh: visualGuideZh, ja: visualGuideJa }
const VISUAL_SKILL_HINT_SOURCES = {
  en: visualSkillHintEn,
  zh: visualSkillHintZh,
  ja: visualSkillHintJa
}

/**
 * 片段里的三段，各由一对界桩 `<!-- shuvix:<name>-start -->` … `<!-- shuvix:<name>-end -->` 圈出：
 *
 *  - `carrier` —— **这张图去哪儿**：聊天里是回复的一部分（其余各段讲的是怎么画，与载体无关）。
 *    一份片段两个出口：{{shuvix:visualGuide}} 带载体，{{shuvix:visualCraft}} 不带。
 *  - `adopt`（嵌在 carrier 里）—— 改图走 `artifact adopt`。只给手里真有 `artifact` 工具的 agent。
 *  - `craft` —— 契约之外的手艺（调色板怎么花、直接标注、一根轴、范例）。这个 agent 的技能货架上
 *    有 `builtin:drawing` 时换成一句「先加载技能」的指路 —— 手艺在技能里，按需才付；没有时原样留下。
 *
 * 契约本身（一个元素一行、viewBox、颜色 token、剥掉什么）不在任何界桩里：图再小也得守，而且
 * 围栏没有「画之前」这个时机可以挂一句「先去加载」，所以它只能常驻。
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
 * 两个选项都描述**这一个 agent 手里有什么**，由宿主按创建时的工具名单判定（见 PromptVarsCtx.toolNames）
 * —— 不是「这个宿主支持什么」。按宿主判就会出现名单上没有、提示里却指着的死路：派发出来的 agent
 * 被告知去加载一个它货架上没有的技能，扩展端被教一个它调不到的 `adopt`。缺省即「没有」。
 */
export interface VisualGuideOptions {
  /** 技能货架上有 `builtin:drawing`（档案点了名，且没在侧栏停用）→ 手艺段换成指路 */
  drawingSkill?: boolean
  /** 工具表里有 `artifact` → 教改图走 adopt（只对带载体的那一档有意义） */
  artifact?: boolean
}

/**
 * `{{shuvix:visualGuide}}` 的取值 —— 内联作图（聊天里的 ```svg 围栏）的规矩与调色板 token。
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
 * `{{shuvix:visualCraft}}` 的取值 —— **同一份片段去掉载体那一段**：契约、调色板 token 与手艺。
 *
 * 给的是「图往文件里画」的档案（笔记本：```svg 围栏在 markdown live preview 里就地渲染，
 * 见 atomic-editor 的 svg-blocks）。载体那段讲的是聊天的规矩 —— 图是回复的一部分、改图走
 * `artifact adopt` —— 对着一个正在编辑文件的 agent 讲那些，是教它一条走不通的路。
 *
 * **刻意不是第二份 md**：契约与手艺两边一字不差，抄成两份迟早只改一边。载体框架短、且天然
 * 属于各档案自己的人格正文，由档案自己写。
 */
export function renderVisualCraft(
  language: string | undefined,
  options?: Pick<VisualGuideOptions, 'drawingSkill'>
): string {
  return render(language, { drawingSkill: options?.drawingSkill }, false)
}

function render(
  language: string | undefined,
  options: VisualGuideOptions,
  carrier: boolean
): string {
  let guide = pickLocalizedSource(VISUAL_GUIDE_SOURCES, language)
  // 先里后外：adopt 嵌在 carrier 里，外层整段删掉时里层的界桩也就一起走了
  guide = applySection(guide, 'adopt', carrier && options.artifact === true)
  guide = applySection(guide, 'carrier', carrier)
  const skill = options.drawingSkill === true
  const hint = skill ? pickLocalizedSource(VISUAL_SKILL_HINT_SOURCES, language).trim() : ''
  guide = applySection(guide, 'craft', !skill, hint)
  return guide.replace(/\n{3,}/g, '\n\n').trim()
}
