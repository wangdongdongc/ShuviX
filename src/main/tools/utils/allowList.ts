/**
 * 命令前缀 → 元数（定义命令身份的 token 数）。
 * 最长前缀优先匹配。未命中字典的命令默认 arity = 1。
 */
const ARITY: Record<string, number> = {
  // ─── 基础 shell 命令（arity 1）───
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  curl: 1,
  date: 1,
  dd: 1,
  df: 1,
  diff: 1,
  du: 1,
  echo: 1,
  env: 1,
  export: 1,
  file: 1,
  find: 1,
  free: 1,
  grep: 1,
  gzip: 1,
  head: 1,
  hostname: 1,
  id: 1,
  ifconfig: 1,
  ip: 1,
  journalctl: 1,
  kill: 1,
  killall: 1,
  less: 1,
  ln: 1,
  lsof: 1,
  ls: 1,
  man: 1,
  mkdir: 1,
  mount: 1,
  mv: 1,
  netstat: 1,
  nslookup: 1,
  open: 1,
  ping: 1,
  pkill: 1,
  printf: 1,
  ps: 1,
  pwd: 1,
  readlink: 1,
  rm: 1,
  rmdir: 1,
  rsync: 1,
  scp: 1,
  sed: 1,
  sleep: 1,
  sort: 1,
  source: 1,
  ss: 1,
  ssh: 1,
  stat: 1,
  sudo: 1,
  tail: 1,
  tar: 1,
  tee: 1,
  top: 1,
  touch: 1,
  traceroute: 1,
  umount: 1,
  uname: 1,
  unset: 1,
  unzip: 1,
  uptime: 1,
  wc: 1,
  wget: 1,
  which: 1,
  who: 1,
  whoami: 1,
  xargs: 1,
  zip: 1,

  // ─── 包管理器 / 系统管理（arity 2）───
  apk: 2,
  apt: 2,
  'apt-get': 2,
  dnf: 2,
  dpkg: 1,
  flatpak: 2,
  iptables: 1,
  launchctl: 2,
  pacman: 1,
  port: 2,
  service: 2,
  snap: 2,
  systemctl: 2,
  ufw: 2,
  yum: 2,
  zypper: 2,

  // ─── 云 / DevOps ───
  aws: 3,
  az: 3,
  flyctl: 2,
  gcloud: 3,
  heroku: 2,
  netlify: 2,
  railway: 2,
  vercel: 2,
  wrangler: 2,

  // ─── 容器 / 编排 ───
  crictl: 2,
  docker: 2,
  'docker compose': 3,
  'docker container': 3,
  'docker image': 3,
  'docker network': 3,
  'docker volume': 3,
  helm: 2,
  kubectl: 2,
  'kubectl rollout': 3,
  nerdctl: 2,
  podman: 2,
  'podman compose': 3,

  // ─── 版本控制 ───
  gh: 3,
  git: 2,
  'git config': 3,
  'git remote': 3,
  'git stash': 3,
  svn: 2,

  // ─── JavaScript / TypeScript ───
  bun: 2,
  'bun run': 3,
  'bun x': 3,
  deno: 2,
  'deno task': 3,
  eslint: 1,
  ng: 2,
  npm: 2,
  'npm exec': 3,
  'npm run': 3,
  npx: 2,
  nvm: 2,
  nx: 2,
  pnpm: 2,
  'pnpm dlx': 3,
  'pnpm exec': 3,
  'pnpm run': 3,
  prettier: 1,
  tsx: 2,
  turbo: 2,
  volta: 2,
  yarn: 2,
  'yarn dlx': 3,
  'yarn run': 3,

  // ─── Python ───
  conda: 2,
  hatch: 2,
  pdm: 2,
  pip: 2,
  pipenv: 2,
  poetry: 2,
  python: 2,
  uv: 2,

  // ─── Go / Rust / Java / Ruby ───
  bazel: 2,
  bundle: 2,
  cargo: 2,
  'cargo add': 3,
  'cargo run': 3,
  cmake: 2,
  composer: 2,
  gem: 2,
  go: 2,
  gradle: 2,
  make: 2,
  mvn: 2,
  rake: 2,
  rustup: 2,
  sbt: 2,
  swift: 2,

  // ─── 版本管理器 ───
  asdf: 2,
  fnm: 2,
  mise: 2,
  pyenv: 2,
  rbenv: 2,

  // ─── 基础设施 ───
  ansible: 2,
  'ansible-playbook': 1,
  pulumi: 2,
  terraform: 2,
  'terraform workspace': 3,
  vagrant: 2
}

/** 按空白拆分命令字符串，尊重引号 */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escape = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escape) {
      current += ch
      escape = false
      continue
    }
    if (ch === '\\') {
      current += ch
      escape = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      continue
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

/** 最长前缀优先匹配 ARITY 字典，返回命令身份 tokens */
function extractPrefix(tokens: string[]): string[] {
  for (let len = tokens.length; len > 0; len--) {
    const prefix = tokens.slice(0, len).join(' ')
    const arity = ARITY[prefix]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  return tokens.length > 0 ? tokens.slice(0, 1) : []
}

/**
 * 将原始命令转换为通配符模式（用于存入允许列表）。
 * - 命令 tokens 多于 prefix → `prefix *`（如 `npm run test` → `npm run *`）
 * - 命令 tokens 等于 prefix → 精确匹配（如 `pwd` → `pwd`）
 */
export function toPattern(command: string): string {
  const tokens = tokenize(command.trim())
  if (tokens.length === 0) return command.trim()
  const prefix = extractPrefix(tokens)
  if (tokens.length > prefix.length) {
    return prefix.join(' ') + ' *'
  }
  return prefix.join(' ')
}

/**
 * 将复合命令拆解为独立的管道单元。
 * 按 &&、||、; 分割，保留管道链 (|) 完整性。
 *
 * 例：`echo "hello" && npm run test | grep pass ; ls`
 *   → [`echo "hello"`, `npm run test | grep pass`, `ls`]
 */
export function splitCommand(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escape = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (escape) {
      current += ch
      escape = false
      continue
    }

    if (ch === '\\') {
      current += ch
      escape = true
      continue
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      continue
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      continue
    }

    if (inSingle || inDouble) {
      current += ch
      continue
    }

    // 检测 && 和 ||
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      const trimmed = current.trim()
      if (trimmed) parts.push(trimmed)
      current = ''
      i++ // 跳过第二个字符
      continue
    }

    // 检测 ;
    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed) parts.push(trimmed)
      current = ''
      continue
    }

    current += ch
  }

  const trimmed = current.trim()
  if (trimmed) parts.push(trimmed)

  return parts
}

/**
 * 复合/控制流结构的首 token 集合。
 * 任一子单元以这些 token 开头 → 命令无法安全归纳为模式(fail-closed)。
 */
const COMPLEX_FIRST_TOKENS = new Set([
  '{',
  '}',
  '(',
  ')',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
  'time',
  'coproc',
  '!'
])

/**
 * 判定命令单元是否包含复合结构(用于 fail-closed 模式提取)。
 * - 首 token 是 `{`/`(` 或 if/for/while 等控制流关键字
 * - 单元内含 `$(...)`、反引号、进程替换 `<(...)`/`>(...)`
 */
function isComplexUnit(unit: string): boolean {
  const tokens = tokenize(unit)
  if (tokens.length === 0) return false
  if (COMPLEX_FIRST_TOKENS.has(tokens[0])) return true
  if (/\$\(|`|<\(|>\(/.test(unit)) return true
  return false
}

/**
 * 从原始命令提取可入 allowList 的模式列表。
 *
 * Fail-closed:命令含复合结构(`{ }`、`( )`、`$()`、反引号、if/for/while 等)
 * 时返回空数组 — 这些结构无法安全归纳为 `cmd *` 模式,用户应按次授权。
 *
 * 例:
 * - `npm run test && ls -la` → `['npm run *', 'ls *']`
 * - `{ echo hi; ls; }`       → `[]`(含 brace group)
 * - `curl "$(cat url.txt)"`  → `[]`(含命令替换)
 */
export function extractPatterns(command: string): string[] {
  const units = splitCommand(command)
  if (units.length === 0) return []
  if (units.some(isComplexUnit)) return []
  return [...new Set(units.map(toPattern))]
}

/**
 * 检查单个命令单元是否匹配允许列表中的某一条。
 * - 精确匹配：`npm run test` 仅匹配 `npm run test`
 * - 通配符匹配：`npm run *` 匹配 `npm run`（无参数）和 `npm run dev`（有参数）
 *   尾部 ` *` 使后续参数变为可选（参考 OpenCode 设计）
 */
function matchesEntry(entry: string, command: string): boolean {
  const p = entry.trim()
  if (p.endsWith(' *')) {
    const base = p.slice(0, -2)
    return command === base || command.startsWith(base + ' ')
  }
  if (p.endsWith('*')) {
    return command.startsWith(p.slice(0, -1))
  }
  return command === p
}

/**
 * 检查命令是否被允许列表放行。
 * 复合命令（含 &&、||、;）会被拆解为子命令，全部子命令都匹配才放行。
 */
export function isCommandAllowed(allowList: string[] | undefined, command: string): boolean {
  if (!allowList || allowList.length === 0) return false
  const units = splitCommand(command)
  if (units.length === 0) return false
  // Fail-closed:复合结构不通过 allowList 自动放行,强制走用户审批
  if (units.some(isComplexUnit)) return false
  return units.every((unit) => allowList.some((entry) => matchesEntry(entry, unit)))
}

// ─── 统一允许列表格式 ──────────────────────────────

import { sep as pathSep } from 'path'

/** 允许列表条目支持的工具类型 */
export type AllowToolType = 'bash' | 'ssh' | 'read' | 'write'

/** toolType ↔ 条目前缀的映射 */
const TOOL_PREFIX: Record<AllowToolType, string> = {
  bash: 'Bash',
  ssh: 'SSH',
  read: 'Read',
  write: 'Write'
}

const PREFIX_TO_TYPE: Record<string, AllowToolType> = {
  Bash: 'bash',
  SSH: 'ssh',
  Read: 'read',
  Write: 'write'
}

/**
 * 解析前缀格式条目:
 * - `Bash(npm run *)` → { toolType: 'bash', pattern: 'npm run *' }
 * - `Read(/abs/path)` → { toolType: 'read', pattern: '/abs/path' }
 */
export function parseAllowEntry(
  entry: string
): { toolType: AllowToolType; pattern: string } | null {
  const m = entry.match(/^(Bash|SSH|Read|Write)\((.+)\)$/)
  if (!m) return null
  const toolType = PREFIX_TO_TYPE[m[1]]
  if (!toolType) return null
  return { toolType, pattern: m[2] }
}

/** 构建前缀格式条目 */
export function buildAllowEntry(toolType: AllowToolType, pattern: string): string {
  return `${TOOL_PREFIX[toolType]}(${pattern})`
}

/**
 * 统一命令允许列表检查(bash / ssh):按 toolType 过滤后委托 isCommandAllowed。
 */
export function isCommandAllowedUnified(
  allowList: string[] | undefined,
  toolType: 'bash' | 'ssh',
  command: string
): boolean {
  if (!allowList || allowList.length === 0) return false
  const filtered = allowList
    .map(parseAllowEntry)
    .filter((e): e is NonNullable<typeof e> => e !== null && e.toolType === toolType)
    .map((e) => e.pattern)
  return isCommandAllowed(filtered, command)
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
    if (matchesPathEntry(parsed.pattern, absolutePath)) return true
  }
  return false
}
