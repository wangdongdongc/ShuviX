/**
 * 工具折叠态摘要函数注册表（按工具名对齐，单一真源）
 *
 * ToolPresentation 经 IPC / HTTP 序列化下发到渲染层，无法携带函数，
 * 因此每个工具的折叠态摘要统一由此处的 (args) => string 函数生成——
 * chat-ui 以源码方式直接 import 本表，按工具名查函数；未注册的工具（MCP /
 * 插件等动态工具）折叠态不显示摘要文本。
 *
 * 注册位置分两类：
 * - 跨端共享内置工具（read/write/edit/ask/preview/git）：就近定义在
 *   builtinToolPresentations.ts 各 def 的 buildSummary 字段，本表自动收集。
 * - 其余工具（实现散落在各端进程内，函数无法随 presentation 跨序列化边界）：
 *   直接在下方 EXTRA_SUMMARY_BUILDERS 按工具名补充。
 */
import { BUILTIN_TOOL_PRESENTATIONS } from './builtinToolPresentations'
import { asStr, field, fileField } from './toolSummaryHelpers'

/** 根据工具调用 args 生成折叠态摘要文本；返回 undefined 表示无摘要 */
export type ToolSummaryBuilder = (args: Record<string, unknown>) => string | undefined

/** 非共享定义的工具摘要函数（按工具名对齐各端注册的工具） */
const EXTRA_SUMMARY_BUILDERS: Record<string, ToolSummaryBuilder> = {
  // ── 桌面端主进程注册的内置工具 ──
  bash: (args) => {
    const description = asStr(args.description)
    const timeout = asStr(args.timeout)
    return [description, timeout && `${timeout}s`].filter(Boolean).join(' · ') || undefined
  },
  ssh: field('description'),
  database: field('description'),
  ls: fileField('path'),
  glob: field('pattern'),
  grep: field('pattern'),
  skill: field('name'),
  // ── 统一 browser 工具（桌面 + 扩展）：action + 该 action 最有信息量的参数 ──
  browser: (args) => {
    const detail = asStr(args.url) ?? asStr(args.text) ?? asStr(args.key) ?? asStr(args.uid)
    return [asStr(args.action), detail].filter(Boolean).join(' ') || undefined
  },
  // ── 扩展端旧离散浏览器工具（已并入 browser，保留供历史会话展示） ──
  open_tab: field('url'),
  read_page: field('tabId'),
  snapshot: field('tabId'),
  click: field('uid'),
  fill: field('text'),
  key: field('key'),
  navigate: field('url'),
  screenshot: field('tabId'),
  // ── 旧派发工具名（现为小写 `agent`，保留供历史会话展示） ──
  Agent: (args) => BUILTIN_TOOL_PRESENTATIONS.agent.buildSummary?.(args)
}

/** 全量摘要函数注册表：共享内置定义（buildSummary 字段）+ 上方补充条目 */
export const TOOL_SUMMARY_BUILDERS: Record<string, ToolSummaryBuilder> = {
  ...Object.fromEntries(
    Object.entries(BUILTIN_TOOL_PRESENTATIONS).flatMap(([name, def]) =>
      def.buildSummary ? [[name, def.buildSummary] as const] : []
    )
  ),
  ...EXTRA_SUMMARY_BUILDERS
}

/** 生成工具折叠态摘要；无注册函数、函数返回空或抛错时返回 undefined */
export function buildToolSummary(
  toolName: string,
  args?: Record<string, unknown>
): string | undefined {
  const builder = TOOL_SUMMARY_BUILDERS[toolName]
  if (!builder || !args) return undefined
  try {
    return builder(args) || undefined
  } catch {
    return undefined
  }
}
