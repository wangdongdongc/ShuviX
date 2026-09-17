/**
 * `~/.ssh/config` 别名枚举 —— 只做**枚举**，不做解析。
 *
 * 这个分工是刻意的：OpenSSH 配置的难点全在解析（`Match` 条件、参数先到先得、`Host *` 缺省、
 * `IdentityAgent`、`ProxyJump` 链……），在 JS 里重写一份只会得到一个**近似实现** —— 用户以为
 * 在用自己的配置，实际用的是我们的仿制品。所以真正建连时把别名原样交给 `ssh`，由它自己解析。
 *
 * 这里只回答一个问题：**这份配置里有哪些可以直接连的别名**，外加每个别名自己块里写着的
 * HostName / User / Port（仅供模型辨认是哪台机器，不是解析结果 —— 不合并 `Host *` 的缺省值）。
 *
 * **不跑 `ssh -G`**：`-G` 会求值 `Match exec` 块，也就是真的执行用户配置里的 shell 命令。
 * 「列一下有哪些主机」不该有副作用，也不该为此拉起几十个进程。
 */
import { readFileSync, existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname, isAbsolute, basename } from 'path'
import { createLogger } from '../../logger'

const log = createLogger('ssh:config')

/** Include 递归深度上限 —— 环已由 visited 挡住，这层只防病态深度 */
const MAX_INCLUDE_DEPTH = 8

/** 一个可连的 host 别名（值取自该别名自己的块，未做 OpenSSH 的完整求值） */
export interface SshHostEntry {
  alias: string
  hostname?: string
  user?: string
  port?: number
}

/** 默认配置路径 */
export function defaultSshConfigPath(): string {
  return join(homedir(), '.ssh', 'config')
}

/** `Host` 的模式项不是可连的别名：通配、否定、纯缺省块 */
function isConnectableAlias(token: string): boolean {
  return token.length > 0 && !token.startsWith('!') && !token.includes('*') && !token.includes('?')
}

/** 把一行拆成 keyword + 剩余部分（OpenSSH 允许空白或 `=` 分隔，keyword 大小写不敏感） */
function splitDirective(line: string): { keyword: string; rest: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*=?\s*(.*)$/.exec(trimmed)
  if (!m) return null
  return { keyword: m[1].toLowerCase(), rest: m[2].trim() }
}

/** 值可能带引号 */
function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/** `Host a b "c d"` 的实参切分（按空白，支持引号） */
function splitArgs(rest: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rest)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * 展开 `Include` 的实参为具体文件路径列表。
 *
 * 相对路径按 OpenSSH 的规则落在 `~/.ssh/` 下（不是当前文件所在目录 —— 用户配置里
 * `Include conf.d/*` 指的就是 `~/.ssh/conf.d/*`）。只支持最后一段带 `*` / `?` 的通配，
 * 这覆盖了现实中的写法，也免得引入一个 glob 依赖或用 Node 的实验 API。
 */
function expandInclude(arg: string, sshDir: string): string[] {
  const raw = arg.startsWith('~/') ? join(homedir(), arg.slice(2)) : arg
  const full = isAbsolute(raw) ? raw : join(sshDir, raw)
  const name = basename(full)
  if (!name.includes('*') && !name.includes('?')) {
    return existsSync(full) ? [full] : []
  }
  const dir = dirname(full)
  if (!existsSync(dir)) return []
  const re = new RegExp(
    '^' +
      name
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  )
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && re.test(e.name))
      .map((e) => join(dir, e.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * 扫一份配置（含 Include），把别名按**首次出现顺序**收集起来。
 *
 * 同名别名多次出现只留第一次（OpenSSH 的参数也是先到先得），所以后续块里的
 * HostName/User/Port 不会覆盖先前已记下的值。
 */
function scanFile(
  path: string,
  sshDir: string,
  depth: number,
  visited: Set<string>,
  out: Map<string, SshHostEntry>
): void {
  if (depth > MAX_INCLUDE_DEPTH || visited.has(path)) return
  visited.add(path)

  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err: unknown) {
    log.warn(`读取失败 ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // 当前 Host 块里可连的别名（`Host bastion *.internal` 这种只留 bastion）
  let current: string[] = []

  for (const line of text.split(/\r?\n/)) {
    const d = splitDirective(line)
    if (!d) continue

    if (d.keyword === 'host') {
      current = splitArgs(d.rest).filter(isConnectableAlias)
      for (const alias of current) {
        if (!out.has(alias)) out.set(alias, { alias })
      }
      continue
    }

    if (d.keyword === 'include') {
      for (const arg of splitArgs(d.rest)) {
        for (const file of expandInclude(arg, sshDir)) {
          scanFile(file, sshDir, depth + 1, visited, out)
        }
      }
      continue
    }

    // `Match` 块的内容不属于任何别名：它是条件求值的产物，枚举阶段不碰
    if (d.keyword === 'match') {
      current = []
      continue
    }

    if (current.length === 0) continue
    for (const alias of current) {
      const entry = out.get(alias)
      if (!entry) continue
      if (d.keyword === 'hostname' && entry.hostname === undefined) {
        entry.hostname = unquote(d.rest)
      } else if (d.keyword === 'user' && entry.user === undefined) {
        entry.user = unquote(d.rest)
      } else if (d.keyword === 'port' && entry.port === undefined) {
        const n = Number.parseInt(unquote(d.rest), 10)
        if (Number.isInteger(n) && n > 0 && n < 65536) entry.port = n
      }
    }
  }
}

/**
 * 列出配置里所有可连的 host 别名。配置不存在就是空列表 —— 这不是错误，
 * 只是这台机器还没有配过 ssh。
 */
export function listSshHosts(configPath: string = defaultSshConfigPath()): SshHostEntry[] {
  const out = new Map<string, SshHostEntry>()
  if (!existsSync(configPath)) return []
  scanFile(configPath, dirname(configPath), 0, new Set<string>(), out)
  return [...out.values()]
}
