/**
 * 内置 MCP 能力服务器的工具呈现 —— 「专属渲染」这项特权真正接上的地方。
 *
 * 第三方 MCP 工具在界面上只有通用形态（扳手图标、原始工具名、没有摘要）。内置 server
 * （进程内、代码随产品发布）的工具名是确定的 `mcp__<server>__<tool>`，于是可以像内置工具一样
 * 给图标、标签、折叠摘要和详情形态。
 *
 * **认名字要认全**：server 名唯一、内置行占着 `browser` / `ssh` / `database`（桌面 v27 / v28 迁移、
 * 扩展 mcpStore 都会给撞名的自定义行改名），但光凭前缀还不够 —— 一台叫 `browser__x` 的自定义 server，
 * 它的工具 `mcp__browser__x__tool` 也以 `mcp__browser__` 开头，于是会在询问卡片上顶着
 * 「浏览器」的名字和图标出现。所以前缀之后的那一截还必须是这台内置 server 真有的工具名
 * （`toolNames`；与 server 那边工具目录的一致性由守护用例钉住）。
 *
 * 另收**历史兼容**：browser 曾是一个 multiplex 内置工具（名字就叫 `browser`），database 曾是一个
 * 内置工具（名字就叫 `database`）—— 旧会话里的这些块要照旧有图标与标签（摘要仍在 toolSummaries
 * 的 `browser` / `database` 条目里）。
 */
import type { ToolPresentation } from './types/toolPresentation'
import { asStr, fileNameOf } from './toolSummaryHelpers'

interface BuiltinMcpServerPresentationDef {
  /** i18n label key（各端用自身 t 解析） */
  labelKey: string
  /** 这台内置 server 的全部工具名（不带前缀）—— 不在其中的不认，见文件头 */
  toolNames: readonly string[]
  /** server 级渲染配置（不含 label） */
  presentation: Omit<ToolPresentation, 'label'>
  /** 个别工具的渲染覆写（如 ssh exec 的终端形态） */
  tools?: Record<string, Omit<ToolPresentation, 'label'>>
  /** 折叠态摘要：工具名（不带前缀）+ 参数 → 一行文字 */
  summary: (tool: string, args: Record<string, unknown>) => string | undefined
}

const BROWSER_ICON: Omit<ToolPresentation, 'label'> = { icon: 'Globe', iconColor: '#60a5fa' }
const DATABASE_ICON: Omit<ToolPresentation, 'label'> = { icon: 'Database', iconColor: '#f59e0b' }

/** 多行代码的第一行有内容的那一行（开头的空行不算） */
function firstLine(v: unknown): string | undefined {
  return asStr(v)
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean)
}

/** 上传的文件列表：只露文件名 */
function fileList(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined
  const names = v.map((p) => fileNameOf(p)).filter((n): n is string => !!n)
  return names.length > 0 ? names.join(', ') : undefined
}

export const BUILTIN_MCP_PRESENTATIONS: Record<string, BuiltinMcpServerPresentationDef> = {
  browser: {
    labelKey: 'tool.browserLabel',
    toolNames: [
      'list_tabs',
      'open_tab',
      'close_tab',
      'navigate',
      'snapshot',
      'read_page',
      'screenshot',
      'click',
      'fill',
      'type',
      'press_key',
      'hover',
      'upload_file',
      'scroll',
      'wait_for',
      'evaluate',
      'network',
      'console',
      'pdf',
      'cdp',
      'events',
      'cdp_recipes'
    ],
    presentation: BROWSER_ICON,
    // 与旧 multiplex `browser` 工具的折叠行同一个样子：「动作 + 最有信息量的参数」——
    // 历史会话与新会话里的浏览器步骤读起来是一回事
    summary: (tool, args) => {
      const detail =
        asStr(args.url) ??
        // navigate 的 back / forward / reload 没有地址
        asStr(args.nav) ??
        asStr(args.text) ??
        asStr(args.key) ??
        fileList(args.paths) ??
        asStr(args.uid) ??
        asStr(args.method) ??
        asStr(args.event) ??
        firstLine(args.expression) ??
        fileNameOf(args.outputPath) ??
        asStr(args.direction) ??
        asStr(args.tabId)
      return [tool, detail].filter(Boolean).join(' ') || undefined
    }
  },
  ssh: {
    labelKey: 'tool.sshLabel',
    toolNames: ['list-hosts', 'exec', 'upload', 'download', 'sync', 'disconnect'],
    presentation: { icon: 'SquareTerminal', iconColor: '#38bdf8' },
    // exec 的参数与结果本来就是一次终端交互的两半（与 bash 同形）
    tools: { exec: { icon: 'Terminal', iconColor: '#38bdf8', detailView: 'terminal' } },
    summary: (tool, args) => {
      const host = asStr(args.host)
      switch (tool) {
        case 'exec':
          return [host, asStr(args.description)].filter(Boolean).join(' · ') || undefined
        case 'upload':
          return (
            [host, [fileNameOf(args.localPath), asStr(args.remotePath)].filter(Boolean).join(' → ')]
              .filter(Boolean)
              .join(' · ') || undefined
          )
        case 'download':
          return (
            [host, [asStr(args.remotePath), fileNameOf(args.localPath)].filter(Boolean).join(' → ')]
              .filter(Boolean)
              .join(' · ') || undefined
          )
        case 'sync': {
          const local = asStr(args.localPath)
          const remote = asStr(args.remotePath)
          const route =
            asStr(args.direction) === 'down'
              ? [remote, local].filter(Boolean).join(' → ')
              : [local, remote].filter(Boolean).join(' → ')
          return [host, route].filter(Boolean).join(' · ') || undefined
        }
        default:
          return host
      }
    }
  },
  database: {
    labelKey: 'tool.remoteDbLabel',
    toolNames: ['list-connections', 'query'],
    presentation: DATABASE_ICON,
    // 「连接名 · 这条查询在做什么」—— 模型没写说明时退到 SQL 的第一行
    summary: (tool, args) =>
      tool === 'query'
        ? [asStr(args.connection), asStr(args.description) ?? firstLine(args.sql)]
            .filter(Boolean)
            .join(' · ') || undefined
        : undefined
  }
}

/** 旧工具名 → 呈现（工具已退役，只为历史会话里的块照旧有图标与标签） */
const LEGACY_TOOL_PRESENTATIONS: Record<
  string,
  { labelKey: string; presentation: Omit<ToolPresentation, 'label'> }
> = {
  browser: { labelKey: 'tool.browserLabel', presentation: BROWSER_ICON },
  database: { labelKey: 'tool.remoteDbLabel', presentation: DATABASE_ICON }
}

/**
 * `mcp__<server>__<tool>` → { server, tool }；只认内置 server 的**真实工具名** ——
 * 前缀对上但工具名不在清单里的（比如一台叫 `browser__x` 的自定义 server）一律不认。
 */
export function parseBuiltinMcpToolName(
  toolName: string
): { server: string; tool: string } | undefined {
  for (const [server, def] of Object.entries(BUILTIN_MCP_PRESENTATIONS)) {
    const prefix = `mcp__${server}__`
    if (!toolName.startsWith(prefix)) continue
    const tool = toolName.slice(prefix.length)
    return def.toolNames.includes(tool) ? { server, tool } : undefined
  }
  return undefined
}

/** 内置 MCP 工具的折叠摘要；不是内置 server 的工具返回 undefined */
export function builtinMcpToolSummary(
  toolName: string,
  args: Record<string, unknown>
): string | undefined {
  const parsed = parseBuiltinMcpToolName(toolName)
  if (!parsed) return undefined
  return BUILTIN_MCP_PRESENTATIONS[parsed.server].summary(parsed.tool, args)
}

/**
 * 宿主下发的呈现表里没有这个工具时的兜底：内置 MCP 工具按 server 给呈现，退役的旧工具给历史呈现。
 * 两样都不是 → undefined（界面走通用形态）。
 */
export function fallbackToolPresentation(
  toolName: string,
  t: (key: string) => string
): ToolPresentation | undefined {
  const parsed = parseBuiltinMcpToolName(toolName)
  if (parsed) {
    const def = BUILTIN_MCP_PRESENTATIONS[parsed.server]
    return { label: t(def.labelKey), ...def.presentation, ...def.tools?.[parsed.tool] }
  }
  // 自有属性才算：`toString` / `constructor` 这类名字不能从原型上捡到一个「呈现」
  if (!Object.prototype.hasOwnProperty.call(LEGACY_TOOL_PRESENTATIONS, toolName)) return undefined
  const legacy = LEGACY_TOOL_PRESENTATIONS[toolName]
  return { label: t(legacy.labelKey), ...legacy.presentation }
}
