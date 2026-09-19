/**
 * 内置档案的声明式 spec + 统一构建器 —— 所有内置 agent（含四个基座档案）走同一套处理。
 *
 * **文案的唯一事实源是 md 文件**（同目录 `md/<name>[.<lang>].md`），格式与用户档案
 * `~/.shuvix/agents/<name>.md` 完全一致、经同一个 parseAgentDefinitionFile 解析。
 * 这些文件**随包发布到磁盘**，运行时现读：桌面把它们作为 extraResources 装进
 * `Resources/builtin-agents/`，`readMd` 就是从那儿读 —— 用户在侧栏点开一份内置档案时，
 * 打开的正是运行时读的那一份文件（只读笔记本），不存在「跑的是内联字符串、看的是另一份」。
 * 没有文件系统的宿主（浏览器扩展）注入构建期内联的读取口（见 inlineSources.ts）——
 * 内联的是**同一批文件**的构建产物，仓库里仍然只有一份源。
 *
 * 语言解析：精确语言 → 基础语言 → en（`<name>.<lang>.md` → `<name>.<base>.md` → `<name>.md`），
 * **按文件整体回退**（半中半英的档案比全英文更难读）。未翻译的语言文件里正文先放英文原文，
 * 翻译债因此出现在正确的位置。
 *
 * 宿主参数（`{{widgetsRoot}}`）在**构建档案时**就地替换（设置页/只读笔记本之外的地方展示
 * 内置档案时看到的是真实路径而非占位符）；spec 经 requiredParams 声明依赖，deps 缺参时该
 * agent 自动跳过（如扩展无 widget 根目录）。会话级的 `{{shuvix:*}}` 占位符不在此处理，
 * 留给 createAgent。
 */
import { parseAgentDefinitionFile } from '../../agentProfile/definitionFile'
import type { AgentProfile } from '../types'

/**
 * 读一份内置 md 的原文（宿主注入）。入参是目录内的文件名（`work.zh.md`），
 * 该语言没有这一版时返回 null —— 构建器据此按语言回退。
 */
export type BuiltinMdReader = (fileName: string) => string | null

/** 内置档案声明 —— 纯结构，文案全在 md 里 */
export interface BuiltinProfileSpec {
  name: string
  /** md 正文/描述里的宿主参数名；deps 缺参时跳过本 agent */
  requiredParams?: readonly 'widgetsRoot'[]
}

export interface BuiltinProfileDeps {
  /** 当前界面语言（i18next.language，如 'zh' / 'zh-CN' / 'ja'）；缺省 en */
  language?: string
  /** widget 根目录（桌面 ~/.shuvix/widgets 展开路径）；缺省时跳过 widget agent */
  widgetsRoot?: string
  /** 内置 md 的读取口（见 BuiltinMdReader） */
  readMd: BuiltinMdReader
  /**
   * 这份 md 的绝对路径（桌面注入）—— 内置档案的 `basePath` 就是它，于是「运行时读的那一份」
   * 与「UI 打开的那一份」由同一次语言回退决定，不会各挑各的。没有文件系统的宿主省略即 ''。
   */
  mdPath?: (fileName: string) => string
}

/**
 * 某个内置 agent 在该语言下的候选文件名，按优先级排列：精确语言 → 基础语言 → en（无后缀）。
 * 导出供宿主复用同一套回退规则（扩展的浏览器变体档案、桌面按名找文件都用它）。
 */
export function builtinMdFileNames(name: string, language: string | undefined): string[] {
  const lang = (language || 'en').toLowerCase()
  const base = lang.split('-')[0]
  // Set 去重：lang === base（'zh'）或语言就是 en 时，候选会重复
  return [...new Set([`${name}.${lang}.md`, `${name}.${base}.md`, `${name}.md`])]
}

/**
 * 一组按语言分版的 md 原文（键为语言代码，'en' 必有）。
 *
 * **agent md 不再走这条路**（它随包发布、运行时按文件读，见 BuiltinMdReader）；留着是因为
 * 另外三家内置 md —— 安全策略、hook、提示词片段 —— 仍是构建期 `?raw` 内联的表，它们与
 * agent md 共用同一套语言回退规则，规则只该有一份。
 */
export type BuiltinProfileSources = Record<string, string> & { en: string }

/**
 * 按语言挑一份原文：精确匹配（zh-CN）→ 基础语言（zh）→ en。与 builtinMdFileNames 是
 * 同一条规则的两种形态（一个挑表里的键，一个挑目录里的文件名）。
 */
export function pickLocalizedSource(
  sources: Record<string, string>,
  language: string | undefined
): string {
  const lang = (language || 'en').toLowerCase()
  return sources[lang] ?? sources[lang.split('-')[0]] ?? sources.en
}

/** 宿主参数插值：`{{name}}`（不含 shuvix: 前缀的才是宿主参数，会话变量留给 createAgent） */
function interpolateHostParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z][\w-]*)\}\}/g, (match, key: string) => params[key] ?? match)
}

/**
 * 按 spec + 宿主 deps 现算一个内置档案；缺必需参数、或一份候选文件都读不到时返回 null。
 * md 格式非法也返回 null —— 内置 md 随包发布，出现即为开发期错误（有守护测试）。
 */
export function buildBuiltinProfile(
  spec: BuiltinProfileSpec,
  deps: BuiltinProfileDeps
): AgentProfile | null {
  const params: Record<string, string> = {}
  for (const key of spec.requiredParams ?? []) {
    const value = deps[key]
    if (!value) return null
    params[key] = value
  }

  for (const fileName of builtinMdFileNames(spec.name, deps.language)) {
    const source = deps.readMd(fileName)
    if (source === null) continue
    const raw = interpolateHostParams(source, params)
    // 内置 md 解析失败属开发期错误（随包发布）——诊断通道现成，别静默
    const parsed = parseAgentDefinitionFile(raw, spec.name, (msg) =>
      console.warn(`[builtinAgents] ${fileName}: ${msg}`)
    )
    if (!parsed) return null
    return { ...parsed, source: 'builtin', basePath: deps.mdPath?.(fileName) ?? '' }
  }
  console.warn(`[builtinAgents] no md found for "${spec.name}"`)
  return null
}
