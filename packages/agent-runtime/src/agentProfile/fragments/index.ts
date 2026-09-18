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
  const guide = pickLocalizedSource(VISUAL_GUIDE_SOURCES, language)
  const hint = options?.skillShelf
    ? pickLocalizedSource(VISUAL_SKILL_HINT_SOURCES, language).trim()
    : ''
  return guide
    .replace(SKILL_HINT_MARKER, hint)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
