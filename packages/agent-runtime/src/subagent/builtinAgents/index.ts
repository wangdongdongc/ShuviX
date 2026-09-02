/**
 * 内置档案（md 文件 + 统一构建器，跨端共享）。
 *
 * 所有内置 agent —— 含两个基座档案 default / notebook —— 的文案都以 `md/<name>[.<lang>].md`
 * 维护，格式与用户档案 `~/.shuvix/agents/<name>.md` 完全一致、经同一个解析器读取。
 * 构建期由 `?raw` 内联进 bundle（部署后不落磁盘，用户看不到也改不到，与迁移前的 TS
 * 字面量鲁棒性相同）；宿主 registry 调 buildBuiltinProfiles(deps) 现算列表（语言切换 /
 * 宿主参数变化自动跟随），用户仍可用同名用户档案覆盖（合并逻辑在各端 registry 内）。
 *
 * 加一个内置 agent = 在 md/ 放三份文件 + 在本文件加一条 import 与一个 spec 条目。
 */
import type { AgentProfile } from '../types'
import { buildBuiltinProfile, type BuiltinProfileDeps, type BuiltinProfileSpec } from './spec'

import defaultEn from './md/default.md?raw'
import defaultZh from './md/default.zh.md?raw'
import defaultJa from './md/default.ja.md?raw'
import codingEn from './md/coding.md?raw'
import codingZh from './md/coding.zh.md?raw'
import codingJa from './md/coding.ja.md?raw'
import notebookEn from './md/notebook.md?raw'
import notebookZh from './md/notebook.zh.md?raw'
import notebookJa from './md/notebook.ja.md?raw'
import browserEn from './md/browser.md?raw'
import browserZh from './md/browser.zh.md?raw'
import browserJa from './md/browser.ja.md?raw'
import exploreEn from './md/explore.md?raw'
import exploreZh from './md/explore.zh.md?raw'
import exploreJa from './md/explore.ja.md?raw'
import visualizationEn from './md/visualization.md?raw'
import visualizationZh from './md/visualization.zh.md?raw'
import visualizationJa from './md/visualization.ja.md?raw'
import widgetEn from './md/widget.md?raw'
import widgetZh from './md/widget.zh.md?raw'
import widgetJa from './md/widget.ja.md?raw'
import wikiEn from './md/wiki.md?raw'
import wikiZh from './md/wiki.zh.md?raw'
import wikiJa from './md/wiki.ja.md?raw'
import wikiWriterEn from './md/wiki-writer.md?raw'
import wikiWriterZh from './md/wiki-writer.zh.md?raw'
import wikiWriterJa from './md/wiki-writer.ja.md?raw'
import titlerEn from './md/titler.md?raw'
import titlerZh from './md/titler.zh.md?raw'
import titlerJa from './md/titler.ja.md?raw'
import botIntentEn from './md/bot-intent.md?raw'
import botIntentZh from './md/bot-intent.zh.md?raw'
import botIntentJa from './md/bot-intent.ja.md?raw'
import botNotesEn from './md/bot-notes.md?raw'
import botNotesZh from './md/bot-notes.zh.md?raw'
import botNotesJa from './md/bot-notes.ja.md?raw'

export {
  buildBuiltinProfile,
  pickLocalizedSource,
  type BuiltinProfileDeps,
  type BuiltinProfileSpec,
  type BuiltinProfileSources
} from './spec'

// 基座档案名的事实源在 chat-protocol —— 渲染层（档案选择器）也要用它，而那边够不到本包
import { DEFAULT_PROFILE_NAME } from '@shuvix/chat-protocol/agentProfile'
export { DEFAULT_PROFILE_NAME }
export const NOTEBOOK_PROFILE_NAME = 'notebook'

/**
 * wiki 条目/章程的管理横幅 —— 写在契约文件 frontmatter 的 `description` 字段，
 * 声明 agent 与用户各自拥有文件的哪一半。事实源在 chat-protocol 的 wiki 契约模块
 * （渲染层也要用它，那边够不到本包），与 md/wiki*.md 模板里的同一段文本互为副本
 * （守护测试钉住，改一处会失败）。
 */
export { WIKI_ENTRY_BANNER, WIKI_TOPIC_BANNER } from '@shuvix/chat-protocol/wikiFileContract'

export const DEFAULT_SPEC: BuiltinProfileSpec = {
  name: DEFAULT_PROFILE_NAME,
  sources: { en: defaultEn, zh: defaultZh, ja: defaultJa }
}

export const NOTEBOOK_SPEC: BuiltinProfileSpec = {
  name: NOTEBOOK_PROFILE_NAME,
  sources: { en: notebookEn, zh: notebookZh, ja: notebookJa }
}

/**
 * 编码智能体 —— 从 default 里拆出来的工程人格：完整工具链（含 ssh / database）+ 做事纪律。
 * default 只留通用助手的薄壳，遇到成规模的工程活儿引导用户 `/coding` 切过来。
 */
export const CODING_SPEC: BuiltinProfileSpec = {
  name: 'coding',
  sources: { en: codingEn, zh: codingZh, ja: codingJa }
}

/**
 * 浏览器智能体 —— 把 snapshot/截图这类大块产物挡在调用方上下文之外。
 *
 * 实测依据（真实会话重放 + Kimi API 上的 A/B，见 cdp/SNAPSHOT-ENCODING.md 与提交历史）：
 * 一个浏览器密集会话里 210/315 次工具调用是浏览器操作，外包后主 agent 的重发加权
 * 下降 83%（轮次 297 → 98）—— 省的不只是结果本身，还有其余所有内容的重发次数。
 *
 * 但成败系于**回报形态**：同样的事实，结构化断言式报告让主 agent 的重验率为 0%，
 * 散文式摘要则是 40%~50%——后者直接吃掉一半收益。所以 md 里那套 assertions 模板
 * 不是装饰，是这个 agent 存在的前提。另一条反直觉的实测：报告里明确罗列「没查什么」
 * 会把重验率推到 30%，因为那读起来像是在邀请对方补查。
 *
 * 用 `shuvix-model` 可以把它钉到便宜模型上（档案声明优先，不可用时回落派发方模型）。
 */
export const BROWSER_SPEC: BuiltinProfileSpec = {
  name: 'browser',
  sources: { en: browserEn, zh: browserZh, ja: browserJa }
}

export const EXPLORE_SPEC: BuiltinProfileSpec = {
  name: 'explore',
  sources: { en: exploreEn, zh: exploreZh, ja: exploreJa }
}

export const VISUALIZATION_SPEC: BuiltinProfileSpec = {
  name: 'visualization',
  sources: { en: visualizationEn, zh: visualizationZh, ja: visualizationJa }
}

export const WIDGET_SPEC: BuiltinProfileSpec = {
  name: 'widget',
  sources: { en: widgetEn, zh: widgetZh, ja: widgetJa },
  requiredParams: ['widgetsRoot']
}

/**
 * wiki 一分为二：`wiki` 是对话入口（可 `/wiki` 切换，只读工具 + Agent），
 * `wiki-writer` 是执行侧（不声明会话感知 = 只可派发，握有全部写入/同意/提交政策）。
 * 拆分的判据是爆炸半径 —— 违反后果静默且不可逆的政策必须跑在每次派发的新鲜上下文里，
 * 而对话侧被长对话稀释也无妨：它压根没有写入工具，损坏不了知识库。
 */
export const WIKI_SPEC: BuiltinProfileSpec = {
  name: 'wiki',
  sources: { en: wikiEn, zh: wikiZh, ja: wikiJa },
  requiredParams: ['wikiRoot']
}

export const WIKI_WRITER_SPEC: BuiltinProfileSpec = {
  name: 'wiki-writer',
  sources: { en: wikiWriterEn, zh: wikiWriterZh, ja: wikiWriterJa },
  requiredParams: ['wikiRoot']
}

/**
 * 标题生成 agent —— auto-title 内置工作流的执行侧（不声明会话感知：切成主会话人格无意义）。
 * 模型走 agent md `shuvix-model` 的通用链路：内置档案不声明 → 跟随派发方 = 会话当前模型；
 * 想钉住便宜模型就覆盖 `~/.shuvix/agents/titler.md` 写上 `shuvix-model`
 * （旧的「标题模型」专项设置已废弃）。经 session 工具落标题。
 */
export const TITLER_SPEC: BuiltinProfileSpec = {
  name: 'titler',
  sources: { en: titlerEn, zh: titlerZh, ja: titlerJa }
}

/**
 * 聊天会话（bot）管线的两个阶段档案 —— 设计见 docs/bot-design.md §6.1 / §6.3。
 * 都不声明会话感知：切成主会话人格毫无意义，它们只在 bot 管线里被派发。
 *
 * 两者都**不声明 `shuvix-model`**，但理由不同：
 *  - `bot-intent` 跑在每条消息的首字节路径上，跟随会话模型是最差默认 —— 门控模型是
 *    一等配置，由设置页的「门控模型」选择器写进 `~/.shuvix/agents/bot-intent.md`
 *    覆盖文件（GUI 写覆盖文件，模型链本身零改动）；
 *  - `bot-notes` 异步跑在回复之后，无人等待，跟随会话模型即可。
 *
 * 两者的 `shuvix-tools` 都**刻意留空**：它们经 next 契约把结果交回管线脚本，由脚本调注入
 * 的能力落地（`say` / `remember`），自己不持有任何工具 —— 见 docs/bot-design.md §3.3。
 */
export const BOT_INTENT_SPEC: BuiltinProfileSpec = {
  name: 'bot-intent',
  sources: { en: botIntentEn, zh: botIntentZh, ja: botIntentJa }
}

export const BOT_NOTES_SPEC: BuiltinProfileSpec = {
  name: 'bot-notes',
  sources: { en: botNotesEn, zh: botNotesZh, ja: botNotesJa }
}

/**
 * 内置 spec 全集（两个基座档案 default / notebook 居首，其后为可派发的具名 agent；
 * widget/wiki 依赖宿主根目录参数，缺参自动跳过）
 */
export const BUILTIN_PROFILE_SPECS: readonly BuiltinProfileSpec[] = [
  DEFAULT_SPEC,
  NOTEBOOK_SPEC,
  CODING_SPEC,
  BROWSER_SPEC,
  EXPLORE_SPEC,
  VISUALIZATION_SPEC,
  WIDGET_SPEC,
  WIKI_SPEC,
  WIKI_WRITER_SPEC,
  TITLER_SPEC,
  BOT_INTENT_SPEC,
  BOT_NOTES_SPEC
]

/**
 * 「基座档案」——某种会话形态的创建基座，而非可派发/可切换的具名 agent：
 * `default` 是主会话，`notebook` 是笔记本会话的根 Agent。
 *
 * 两者都可被同名用户档案覆盖（这正是自定义人格的入口），但都不该出现在派发工具的
 * 可用名单里（会诱导 LLM 拿基座档案当一次性任务 agent 使 —— 它们是某种会话形态的人格，
 * 不是为一次性任务写的；论工具清单 default 反而比 coding 窄），也不该作为 `/<agentName>`
 * 切换目标 —— 唯一例外是 `/default`，它是切回主会话基座的入口，由命令源单独放行。
 */
export const BASE_PROFILE_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME
])

/** 按宿主 deps 现算全部可用内置档案（文案按当前语言解析） */
export function buildBuiltinProfiles(deps: BuiltinProfileDeps): AgentProfile[] {
  return BUILTIN_PROFILE_SPECS.map((spec) => buildBuiltinProfile(spec, deps)).filter(
    (p): p is AgentProfile => p !== null
  )
}
