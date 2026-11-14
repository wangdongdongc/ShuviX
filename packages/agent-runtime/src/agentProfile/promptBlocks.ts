/**
 * 提示词块（prompt blocks）—— 档案正文之后由宿主追加的会话相关内容。
 *
 * 档案正文是纯文字：没有占位符，用户写什么模型就看到什么。会话相关的东西（工作目录、日期、作图说明、
 * 打开的是哪份文档……）由宿主渲染成**块**，每块包在一个同名 XML 标签里追加在正文后面。档案用
 * `shuvix-prompt-blocks` 说要哪几块（词表见 chat-protocol `agentPromptBlocks.ts`）。
 *
 * 这里管的是**随人设冻结**的那几块（`document` / `drawing` / `environment`，以及跟着 `tool_search`
 * 工具走、不在词表里的 `extensions`）：创建 agent 时宿主经 `promptBlocks(ctx)` 现算一次，
 * {@link composePersona} 把选中且非空的拼在正文后面，结果整份写进 `AgentStateDoc.persona`。
 * 指令文件与项目提示词是另一种 —— 各自独立的段落，按来源比对是否过期，见 `durable/prompt/sections.ts`。
 *
 * 约定：
 *  - 宿主对每一块自己判条件，不满足就不给（省略或空串）—— 列了不等于一定出现；
 *  - 块的先后固定（{@link PERSONA_BLOCK_ORDER}），与档案里写的顺序无关；
 *  - 块里的文字与正文同语言：界面语言是宿主的权威，档案构建期挑正文用的也是这一个。
 */
import type { AgentPromptBlock } from '@shuvix/chat-protocol/agentPromptBlocks'
import type { InProcessAgentType } from '../subagent/types'

export type AgentKind = 'root' | 'spawned'

export interface PromptBlocksCtx {
  /** root = 会话 id；spawned = agentId（不是一条会话） */
  sessionId: string
  /**
   * 这个 agent 所属的根会话（root = 自身）。派生 agent 的 `sessionId` 是 agentId，查不到会话行；
   * 要会话的项目、工作目录时按它查。可选：旧调用方不传时按 `sessionId` 算
   */
  rootSessionId?: string
  kind: AgentKind
  /** 工作目录（桌面=绝对路径）；派生 agent 为 ''，由宿主按根会话补 */
  cwd: string
  /**
   * 这个 agent 的归一工具名单 —— 与随后交给 resolveTools 的 `names` 是同一份。
   * 块里要提到某项能力（加载哪个技能、调哪个工具）时，据此判断它在不在这个 agent 手里。
   */
  toolNames: readonly string[]
}

/** 随人设冻结的块：词表里的三项，加上跟着 `tool_search` 走的 `extensions` */
export type PersonaBlock = Extract<AgentPromptBlock, 'document' | 'drawing' | 'environment'>

/** 宿主渲染出的块正文（不含标签）；省略 / 空白 = 这一块不出 */
export type PromptBlockTexts = Partial<Record<PersonaBlock | 'extensions', string>>

/** 人设里块的固定次序：先说打开的文档，再是两段能力说明，环境清单收尾 */
const PERSONA_BLOCK_ORDER = ['document', 'drawing', 'extensions', 'environment'] as const

/** 按界面语言取一份（整份回退：`zh-CN` → `zh` → `en`） */
function pickByLanguage<T>(
  sources: { en: T } & Record<string, T>,
  language: string | undefined
): T {
  const lang = (language || 'en').toLowerCase()
  return sources[lang] ?? sources[lang.split('-')[0]] ?? sources.en
}

/** 一块：`<name>\n正文\n</name>` */
export const fencePromptBlock = (name: string, text: string): string =>
  `<${name}>\n${text}\n</${name}>`

/**
 * 人设 = 档案正文 + 选中且有内容的块。`extensions` 不看档案的清单（宿主只在 agent 持有 `tool_search` 时给它）。
 * 正文原样（只修剪首尾），块之间空一行。
 */
export function composePersona(
  profile: Pick<InProcessAgentType, 'systemPrompt' | 'promptBlocks'>,
  texts: PromptBlockTexts
): string {
  const listed = new Set<string>(profile.promptBlocks ?? [])
  const parts = [profile.systemPrompt.trim()]
  for (const name of PERSONA_BLOCK_ORDER) {
    if (name !== 'extensions' && !listed.has(name)) continue
    const text = texts[name]?.trim()
    if (text) parts.push(fencePromptBlock(name, text))
  }
  return parts.filter((part) => part.length > 0).join('\n\n')
}

// ─────────────────────────── environment ───────────────────────────

/** 支持语言的原生名（环境清单输出用户界面语言时用，非翻译文案故不进 locales） */
const LANGUAGE_NATIVE_NAMES: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語'
}

/** 用户界面语言的展示形式（如 zh → 「中文 (zh)」；未知语言原样返回代码） */
export function formatLanguageDisplay(lang: string | undefined): string {
  const base = (lang || 'en').split('-')[0].toLowerCase()
  const native = LANGUAGE_NATIVE_NAMES[base]
  return native ? `${native} (${base})` : base
}

/**
 * 环境清单的事实。**给了才有那一行**：哪几行对这个 agent 有意义由宿主按它的工具名单定
 * （没有命令工具就不说 Shell 和 Git，没有文件工具就不说工作目录）。
 */
export interface EnvironmentFacts {
  workingDirectory?: string
  /** 已渲染好的一整行（`renderTempDirectory`） */
  tempDirectoryLine?: string
  isGitRepo?: string
  platform?: string
  shell?: string
  os?: string
  date?: string
  language?: string
  appVersion?: string
}

type EnvLabel = Exclude<keyof EnvironmentFacts, 'tempDirectoryLine'>

const ENVIRONMENT_LABELS: Record<'en' | 'zh' | 'ja', Record<EnvLabel, string>> = {
  en: {
    workingDirectory: 'Working directory',
    isGitRepo: 'Git repository',
    platform: 'Platform',
    shell: 'Shell',
    os: 'OS',
    date: 'Current date',
    language: 'User language',
    appVersion: 'ShuviX version'
  },
  zh: {
    workingDirectory: '工作目录',
    isGitRepo: 'Git 仓库',
    platform: 'Platform',
    shell: 'Shell',
    os: 'OS',
    date: '当前日期',
    language: '用户语言',
    appVersion: 'ShuviX 版本'
  },
  ja: {
    workingDirectory: '作業ディレクトリ',
    isGitRepo: 'Git リポジトリ',
    platform: 'Platform',
    shell: 'Shell',
    os: 'OS',
    date: '現在の日付',
    language: 'ユーザー言語',
    appVersion: 'ShuviX バージョン'
  }
}

/** `environment` 块的正文：一行一项的清单，只列宿主给了的那几项 */
export function renderEnvironment(language: string | undefined, facts: EnvironmentFacts): string {
  const labels = pickByLanguage(ENVIRONMENT_LABELS, language)
  const line = (key: EnvLabel, value = facts[key]): string | undefined =>
    value ? `- ${labels[key]}: ${value}` : undefined
  return [
    line('workingDirectory'),
    facts.tempDirectoryLine?.trim() || undefined,
    line('isGitRepo'),
    line('platform'),
    line('shell'),
    line('os'),
    line('date'),
    line('language'),
    line('appVersion', facts.appVersion ? `ShuviX ${facts.appVersion}` : undefined)
  ]
    .filter((entry): entry is string => entry !== undefined)
    .join('\n')
}

// ─────────────────────────── document ───────────────────────────

const OPEN_DOCUMENT_LABELS = {
  en: 'Open document',
  zh: '打开的文档',
  ja: '開いているドキュメント'
}

export interface DocumentBlockOptions {
  /** 笔记本会话打开的文档（相对工作目录）；缺省 / 空串 = 不是笔记本会话，整块不出 */
  path?: string
  /** 这份文档是哪种 ShuviX 文件的说明（`renderDocumentKind`）；普通笔记为空 */
  kindGuide?: string
}

/** `document` 块的正文：打开的是哪份文档；是 ShuviX 自己的文件时再说它是什么 */
export function renderDocumentBlock(
  language: string | undefined,
  options: DocumentBlockOptions
): string {
  if (!options.path) return ''
  const label = pickByLanguage(OPEN_DOCUMENT_LABELS, language)
  const guide = options.kindGuide?.trim()
  return [`${label}: \`${options.path}\``, ...(guide ? [guide] : [])].join('\n\n')
}
