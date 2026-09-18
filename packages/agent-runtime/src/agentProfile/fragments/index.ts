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

/** guide 正文里给「去加载作图技能」那段留的位置；宿主没有技能货架时整行消失 */
const SKILL_HINT_MARKER = '<!-- shuvix:skill-hint -->'

/**
 * 「载体」那一段的界桩 —— 从这里到 carrier-end 讲的是**这张图去哪儿**（聊天里是回复的一部分、
 * 改图走 `adopt`），而其后的契约、调色板与范例讲的是**怎么画**，与载体无关。
 * 一份片段两个出口：{{shuvix:visualGuide}} 带载体，{{shuvix:visualCraft}} 只要手艺。
 */
const CARRIER_START = '<!-- shuvix:carrier-start -->'
const CARRIER_END = '<!-- shuvix:carrier-end -->'

/** 去掉界桩本身（带载体那一档）或连同其间的整段（只要手艺那一档） */
function applyCarrier(guide: string, keep: boolean): string {
  const start = guide.indexOf(CARRIER_START)
  const end = guide.indexOf(CARRIER_END)
  // 界桩缺失时原样返回：片段是手维护的 md，少一个标记不该让整段提示消失
  if (start < 0 || end < 0) return guide
  if (keep) return guide.replace(CARRIER_START, '').replace(CARRIER_END, '')
  return guide.slice(0, start) + guide.slice(end + CARRIER_END.length)
}

/**
 * `{{shuvix:visualGuide}}` 的取值 —— 内联作图（聊天里的 ```svg 围栏）的规矩与调色板 token。
 *
 * 自含块：值自带小标题，可直接嵌在正文任意位置。**围栏本身**刻意不做宿主分支 —— 渲染在
 * chat-ui 里（两端共用同一个 CodeBlock），两端都成立。
 *
 * `skillShelf` 是唯一的宿主分支，而且它分的不是围栏、是那句「动笔前先加载 `builtin:drawing`」：
 * 内置技能货架目前只有桌面端有（扩展端的 resolveTools 直接丢弃 `skill:` 名，那边没有 SkillTool）。
 * 少了这个分支，扩展端每个 root agent 的系统提示都会指挥模型去加载一个那里根本不存在的技能 ——
 * 一条永远走不通的指路比没有指路更糟。
 */
export function renderVisualGuide(
  language: string | undefined,
  options?: { skillShelf?: boolean }
): string {
  return render(language, options?.skillShelf === true, true)
}

/**
 * `{{shuvix:visualCraft}}` 的取值 —— **同一份片段去掉载体那一段**：契约、调色板 token 与范例。
 *
 * 给的是「图往文件里画」的档案（笔记本：```svg 围栏在 markdown live preview 里就地渲染，
 * 见 atomic-editor 的 svg-blocks）。载体那段讲的是聊天的规矩 —— 图是回复的一部分、改图走
 * `artifact adopt` —— 对着一个正在编辑文件的 agent 讲那些，是教它一条走不通的路。
 *
 * **刻意不是第二份 md**：手艺那部分（调色板、直接标注、一个元素一行）两边一字不差，抄成两份
 * 迟早只改一边。载体框架短、且天然属于各档案自己的人格正文，由档案自己写。
 */
export function renderVisualCraft(
  language: string | undefined,
  options?: { skillShelf?: boolean }
): string {
  return render(language, options?.skillShelf === true, false)
}

function render(language: string | undefined, skillShelf: boolean, carrier: boolean): string {
  const guide = applyCarrier(pickLocalizedSource(VISUAL_GUIDE_SOURCES, language), carrier)
  const hint = skillShelf ? pickLocalizedSource(VISUAL_SKILL_HINT_SOURCES, language).trim() : ''
  return guide
    .replace(SKILL_HINT_MARKER, hint)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
