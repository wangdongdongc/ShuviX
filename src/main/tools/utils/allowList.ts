/**
 * 命令前缀 → 元数（定义命令身份的 token 数）。
 * 最长前缀优先匹配。未命中字典的命令默认 arity = 1。
 */
const ARITY: Record<string, number> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  curl: 1,
  echo: 1,
  env: 1,
  export: 1,
  find: 1,
  grep: 1,
  head: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  printf: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sed: 1,
  sleep: 1,
  sort: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  wc: 1,
  wget: 1,
  which: 1,
  xargs: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  'bun run': 3,
  'bun x': 3,
  cargo: 2,
  'cargo add': 3,
  'cargo run': 3,
  cmake: 2,
  composer: 2,
  deno: 2,
  'deno task': 3,
  docker: 2,
  'docker compose': 3,
  'docker container': 3,
  'docker image': 3,
  'docker network': 3,
  'docker volume': 3,
  gcloud: 3,
  gh: 3,
  git: 2,
  'git config': 3,
  'git remote': 3,
  'git stash': 3,
  go: 2,
  gradle: 2,
  helm: 2,
  kubectl: 2,
  'kubectl rollout': 3,
  make: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  'npm exec': 3,
  'npm run': 3,
  npx: 2,
  nvm: 2,
  nx: 2,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  'pnpm dlx': 3,
  'pnpm exec': 3,
  'pnpm run': 3,
  poetry: 2,
  podman: 2,
  python: 2,
  rake: 2,
  rustup: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  'terraform workspace': 3,
  turbo: 2,
  vercel: 2,
  volta: 2,
  yarn: 2,
  'yarn dlx': 3,
  'yarn run': 3
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
  return units.every((unit) => allowList.some((entry) => matchesEntry(entry, unit)))
}

// ─── 统一允许列表格式 ──────────────────────────────

/** 解析前缀格式条目：Bash(npm run *) → { toolType: 'bash', pattern: 'npm run *' } */
export function parseAllowEntry(
  entry: string
): { toolType: 'bash' | 'ssh'; pattern: string } | null {
  const m = entry.match(/^(Bash|SSH)\((.+)\)$/)
  if (!m) return null
  return { toolType: m[1].toLowerCase() as 'bash' | 'ssh', pattern: m[2] }
}

/** 构建前缀格式条目 */
export function buildAllowEntry(toolType: 'bash' | 'ssh', pattern: string): string {
  return `${toolType === 'bash' ? 'Bash' : 'SSH'}(${pattern})`
}

/**
 * 统一允许列表检查：按 toolType 过滤后委托 isCommandAllowed。
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
