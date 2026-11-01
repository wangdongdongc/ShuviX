/**
 * bot 定时运行的权限核对（docs/bot-access-check-design.md）—— 写下一份带定时的 bot 文件、或点名它的配套策略之后，
 * 回执里说这个 bot 没人在场时能不问就做哪些事、哪些会停在询问上。
 *
 * 为什么：定时运行没人回答询问。停在询问卡上的那次运行要等用户回来，这条绑定后面的触发也一直跳过 —— 不查的话，
 * 用户要等到第一次触发什么都没发生才知道。用户裁定（2026-10-31）：bot 由 agent 帮用户设置，权限问题由 agent 在创建时
 * 主动查、向用户提出，再帮用户写一份这个 bot 配套的授权策略（日记 bot 的 daily-bot-access 那种）；重点是给 agent
 * 可靠的验证。
 *
 * 所以这里不读 CEL 猜意思，而是拿一组具体客体交给真实引擎判（宿主注入 judge：这个 bot 的根 agent、那个位置的会话
 * 目录、空的权限表）：别的会话读 / 发消息各一次（不分新旧 —— 按新旧授权暂不做，用户 2026-10-31），点名这个 bot 的
 * 策略里出现的路径读写各一次，再加几个本不该放行的反例（家目录里工作文件夹之外、家目录之外、点名路径旁边的文件）。
 * 回执里每一句都来自一次判定：规则写成 allow（压不过 ask）、身份写错、路径拼错，都如实显示为「还是要问」。
 */
import type {
  GateVerdict,
  ParsedPolicyFile,
  SecurityObject,
  SecurityToolRef
} from '../security/types'

export type AccessAction = 'read' | 'write'

/** 一次判定落在哪一类（by = 胜出规则所在的策略名；null = 没有规则拦，默认放行） */
export type AccessOutcome =
  | { kind: 'allowed'; by: string | null }
  /** 普通的 ask：自动审查开着时由它替人答（可能拒绝，拿不准还是问人） */
  | { kind: 'review'; by: string }
  /** 只有人能答（会话 / 组件访问、force-ask、审查关着）：运行会停在这里 */
  | { kind: 'stops'; by: string }
  | { kind: 'denied'; by: string }

export interface BotAccessLocation {
  /** 回执里的位置说法：`project tiny-cli` / `a temporary folder` */
  label: string
  /**
   * 按这个位置的一次定时运行判（宿主：真实引擎的 judgeGate，不弹卡、不送审查）。`tool` 是真实调用会带的那个工具
   * （`read` / `write` / `session` + 动作）—— 按 `tool.name` 收窄的规则在核对里也要照样命中
   */
  judge(action: AccessAction, object: SecurityObject, tool: SecurityToolRef): GateVerdict
  /** 这个位置的宿主事实变量（`vars.workspace` 随位置变）；省略 = host.vars */
  vars?: Record<string, unknown>
}

export interface BotAccessHost {
  home: string
  /** 文件系统根（`/`、`C:\`）—— 家目录之外的反例放在它下面 */
  root: string
  sep: string
  /** 策略里 `vars.*` 的取值（宿主事实变量） */
  vars: Record<string, unknown>
  isDirectory(path: string): boolean
}

export interface BotAccessCheckInput {
  /** bot 的名字（回执里的称呼） */
  botName: string
  /** 策略里认它的那个值（`subject.bot`）：shuvix-id，没有就是名字 */
  identity: string
  /**
   * 身份从哪来：`id` = 文件的 shuvix-id；`name` = 文件没有 id，按名字认（改名就失效）；`untrusted-id` = 文件写了
   * 内置形态的 id，但不是 ShuviX 写下的那份，同样按名字认
   */
  identityFrom: 'id' | 'name' | 'untrusted-id'
  /** 此刻生效、点名了这个 bot 的策略（内置的也算，停用的不算），装配序 */
  naming: readonly ParsedPolicyFile[]
  /** 定时运行会在哪些位置跑（每条绑定的 project 去重；对不上项目的绑定根本不跑，不在这里） */
  locations: readonly BotAccessLocation[]
  /** 自动审查此刻会不会接普通的询问 */
  reviewActive: boolean
  host: BotAccessHost
  /** 回执里写策略目录的说法（`~/.shuvix/policies/`） */
  policiesDirLabel: string
  now: Date
  /** 判完之后取求值出错的告警（宿主的 logger 收集） */
  warnings?: () => readonly string[]
}

/** 至多列几个点名路径（再多就是策略写得太散，回执也读不完） */
const MAX_NAMED_PATHS = 6
const MAX_WARNINGS = 3
/** 反例与目录样例用的文件名：不存在、不像任何人会起的名字 */
const SAMPLE_FILE = 'shuvix-access-check.md'
const OTHER_FILE = 'shuvix-access-check-other.md'
const PROBE_SESSION_ID = 'shuvix-access-check'
/** 这些宿主变量是宽泛的位置（家目录、工作目录）或不是路径：不当点名路径试 */
const BROAD_VARS = new Set(['home', 'workspace', 'now', 'systemDirs'])

/** 一条规则的全部 CEL 文本（match + 策略级 lets） */
function celTexts(policy: ParsedPolicyFile): string[] {
  return [...policy.rules.map((r) => r.match ?? ''), ...Object.values(policy.lets ?? {})].filter(
    (t) => t.length > 0
  )
}

/** CEL 文本里的字符串字面量（单引号或双引号；不处理转义之外的写法） */
function stringLiterals(text: string): string[] {
  const out: string[] = []
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g
  for (const m of text.matchAll(re)) out.push((m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'))
  return out
}

/**
 * 这份策略有没有点名这个 bot：拿它和 `subject.bot` 做相等比较（botIdentitiesNamedBy —— 与策略回执认 bot 同一条规则；
 * `subject.bot != 'x'` 这种排除不算点名）
 */
export function policyNamesBot(policy: ParsedPolicyFile, identity: string): boolean {
  return botIdentitiesNamedBy(policy).includes(identity)
}

/** 一个值写成 CEL 的单引号字符串（回执里给 agent 照抄的条件；名字里可能有引号） */
export function celQuote(value: string): string {
  return `'${value.replace(/[\\']/g, '\\$&')}'`
}

/** 策略里拿来和 `subject.bot` 比的那些身份（`subject.bot == 'x'`、`'x' == subject.bot`、`subject.bot in ['x', …]`） */
export function botIdentitiesNamedBy(policy: ParsedPolicyFile): string[] {
  const found = new Set<string>()
  const lit = `(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`
  for (const text of celTexts(policy)) {
    for (const re of [
      new RegExp(`\\bsubject\\.bot\\s*==\\s*${lit}`, 'g'),
      new RegExp(`${lit}\\s*==\\s*subject\\.bot\\b`, 'g')
    ]) {
      for (const m of text.matchAll(re)) found.add((m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'))
    }
    for (const m of text.matchAll(/\bsubject\.bot\s+in\s*\[([^\]]*)\]/g)) {
      for (const value of stringLiterals(m[1])) found.add(value)
    }
  }
  found.delete('')
  return [...found]
}

function trimSep(path: string, sep: string): string {
  let p = path
  while (p.length > 1 && (p.endsWith(sep) || p.endsWith('/')) && !/^[A-Za-z]:[\\/]$/.test(p)) {
    p = p.slice(0, -1)
  }
  return p
}

function joinPath(dir: string, name: string, sep: string): string {
  return dir.endsWith(sep) || dir.endsWith('/') ? `${dir}${name}` : `${dir}${sep}${name}`
}

function splitParent(path: string, sep: string): { parent: string; base: string } {
  const i = Math.max(path.lastIndexOf(sep), path.lastIndexOf('/'))
  if (i < 0) return { parent: path, base: '' }
  return { parent: i === 0 ? path.slice(0, 1) : path.slice(0, i), base: path.slice(i + 1) }
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

interface NamedPath {
  path: string
  /** 文件夹：试里面的一份样例文件（运行时读写的是里面的文件） */
  dir: boolean
}

/** 点名这个 bot 的策略里出现的路径：字符串字面量（绝对路径或 `~` 开头）与 `vars.*` 里是路径的那些 */
export function namedPathsOf(
  naming: readonly ParsedPolicyFile[],
  host: BotAccessHost
): NamedPath[] {
  return collectNamedPaths(naming, host).paths
}

/** namedPathsOf，外加超出上限没试的有几个（回执里说一句） */
function collectNamedPaths(
  naming: readonly ParsedPolicyFile[],
  host: BotAccessHost
): { paths: NamedPath[]; omitted: number } {
  const out = new Map<string, NamedPath>()
  const skipped = new Set<string>()
  const expand = (raw: string): string | null => {
    const p =
      raw === '~'
        ? host.home
        : raw.startsWith('~/')
          ? joinPath(host.home, raw.slice(2), host.sep)
          : raw
    if (!isAbsoluteLike(p)) return null
    const trimmed = trimSep(p, host.sep)
    // 家目录、根目录本身太宽：由反例那几条说
    if (trimmed === trimSep(host.home, host.sep) || trimmed === trimSep(host.root, host.sep)) {
      return null
    }
    return trimmed
  }
  const add = (raw: string, inDirArg: boolean): void => {
    const path = expand(raw)
    if (!path || out.has(path)) return
    if (out.size >= MAX_NAMED_PATHS) {
      skipped.add(path)
      return
    }
    out.set(path, { path, dir: inDirArg || /[\\/]$/.test(raw) || host.isDirectory(path) })
  }
  for (const policy of naming) {
    for (const raw of celTexts(policy)) {
      // `vars.home + '/notes'` 这种拼接先折成一个字面量（手册的例子就这么写）—— 否则 `'/notes'` 会被当成根下的路径
      const text = raw.replace(
        /\bvars\.([A-Za-z_]\w*)\s*\+\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g,
        (_whole, name: string, single?: string, double?: string) => {
          const value = host.vars[name]
          // 取不到值（拼错的变量名）：连字面量一起丢掉 —— 剩下的 `'/notes'` 不是根下的路径
          if (typeof value !== 'string' || !value) return `vars.${name}`
          const joined = `${value}${(single ?? double ?? '').replace(/\\(.)/g, '$1')}`
          return `'${joined.replace(/['\\]/g, '\\$&')}'`
        }
      )
      const inDirLiterals = new Set<string>()
      for (const m of text.matchAll(
        /\binDir\s*\(\s*object\.path\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
      )) {
        inDirLiterals.add((m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'))
      }
      const inDirVars = new Set(
        [...text.matchAll(/\binDir\s*\(\s*object\.path\s*,\s*vars\.([A-Za-z_]\w*)/g)].map(
          (m) => m[1]
        )
      )
      for (const literal of stringLiterals(text)) add(literal, inDirLiterals.has(literal))
      for (const m of text.matchAll(/\bvars\.([A-Za-z_]\w*)/g)) {
        const name = m[1]
        if (BROAD_VARS.has(name)) continue
        const value = host.vars[name]
        const values = Array.isArray(value) ? value : [value]
        for (const v of values) if (typeof v === 'string' && v) add(v, inDirVars.has(name))
      }
    }
  }
  return { paths: [...out.values()], omitted: skipped.size }
}

/** 一次判定 → 哪一类（胜出规则的 id 是 `<策略名>#<序号>`；`default:<type>` = 没有规则命中） */
export function accessOutcomeOf(
  verdict: GateVerdict,
  objectType: string,
  reviewActive: boolean
): AccessOutcome {
  const winning = verdict.decision.winning
  const by = winning.startsWith('default:') ? null : winning.replace(/#\d+$/, '')
  if (verdict.allowed) return { kind: 'allowed', by }
  const policy = by ?? winning
  if (verdict.decision.effect === 'deny') return { kind: 'denied', by: policy }
  // 审查只接普通的 ask：force-ask 的意思就是只问人；会话、组件访问的询问审查 hook 不接（它的 when）
  const reviewable =
    reviewActive &&
    verdict.decision.tier === 'ask' &&
    objectType !== 'session' &&
    objectType !== 'widget'
  return { kind: reviewable ? 'review' : 'stops', by: policy }
}

function outcomeText(o: AccessOutcome): string {
  switch (o.kind) {
    case 'allowed':
      return o.by ? `allowed (${o.by})` : 'allowed (nothing asks)'
    case 'review':
      return `asks (${o.by}; the automatic review answers at run time and may refuse)`
    case 'stops':
      return `asks (${o.by}; only the user can answer, so the run would stop)`
    case 'denied':
      return `denied (${o.by})`
  }
}

/** 放得比点名的路径宽：反例被某条策略（不是默认）放行了 */
function overGranted(o: AccessOutcome): o is { kind: 'allowed'; by: string } {
  return o.kind === 'allowed' && o.by !== null
}

function pathObject(path: string): SecurityObject {
  return { type: 'path', path, displayPath: path }
}

/** 真实调用会带的工具：文件工具读写、session 工具查看 / 发消息 */
const READ_TOOL: SecurityToolRef = { name: 'read' }
const WRITE_TOOL: SecurityToolRef = { name: 'write' }
const pathTool = (action: AccessAction): SecurityToolRef =>
  action === 'read' ? READ_TOOL : WRITE_TOOL
const SESSION_TOOL: Record<AccessAction, SecurityToolRef> = {
  read: { name: 'session', operation: 'read-session' },
  write: { name: 'session', operation: 'prompt-session' }
}

/**
 * 求值出错的告警 → 一句：规则 id、错误第一行、引擎怎么处置（allow / force-allow 不命中，ask / deny 照样命中 ——
 * 引擎的 fail-safe）。CEL 的错误带源码与插入符，只要第一行；不是那种告警的原样取第一行
 */
function warningText(warning: string): string {
  const m =
    /^security rule '([^']+)': match evaluation failed \(([\s\S]*)\), (treating as .*)$/.exec(
      warning.trim()
    )
  if (!m) return warning.split('\n')[0].trim()
  return `${m[1]} (${m[2].split('\n')[0].trim()}) — ${m[3].trim()}`
}

function tilde(path: string, home: string, sep: string): string {
  const h = trimSep(home, sep)
  return path === h ? '~' : path.startsWith(`${h}${sep}`) ? `~${path.slice(h.length)}` : path
}

/** 一个位置的判定结果 → 那几行（不含标题） */
function locationLines(
  location: BotAccessLocation,
  input: BotAccessCheckInput
): { lines: string[]; stops: boolean } {
  const { reviewActive } = input
  const host: BotAccessHost = location.vars ? { ...input.host, vars: location.vars } : input.host
  const { paths: named, omitted } = collectNamedPaths(input.naming, host)
  let stops = false
  const verdictOf = (action: AccessAction, object: SecurityObject): AccessOutcome =>
    accessOutcomeOf(
      location.judge(
        action,
        object,
        object.type === 'session' ? SESSION_TOOL[action] : pathTool(action)
      ),
      object.type,
      reviewActive
    )
  const judge = (action: AccessAction, object: SecurityObject): AccessOutcome => {
    const outcome = verdictOf(action, object)
    if (outcome.kind === 'stops') stops = true
    return outcome
  }
  const show = (p: string): string => tilde(p, host.home, host.sep)
  const lines: string[] = []

  const session: SecurityObject = {
    type: 'session',
    sessionId: PROBE_SESSION_ID,
    title: '',
    ownTurn: false,
    // 与这个位置的 vars.now 同一刻（按「最近多久」放行的规则拿它俩比）
    lastActiveAt: typeof host.vars.now === 'string' ? host.vars.now : input.now.toISOString(),
    bot: ''
  }
  lines.push(`- read other sessions: ${outcomeText(judge('read', session))}.`)
  lines.push(`- send messages into other sessions: ${outcomeText(judge('write', session))}.`)

  const extra: string[] = []
  for (const n of named) {
    const target = n.dir ? joinPath(n.path, SAMPLE_FILE, host.sep) : n.path
    const label = n.dir ? `files in ${show(n.path)}${host.sep}` : show(n.path)
    const read = outcomeText(judge('read', pathObject(target)))
    const write = outcomeText(judge('write', pathObject(target)))
    lines.push(
      read === write
        ? `- ${label}: read and write ${read}.`
        : `- ${label}: read ${read}; write ${write}.`
    )
    // 旁边的那一份：同一父目录下另一个名字（文件夹就是旁边另一个文件夹里的文件）
    const { parent, base } = splitParent(n.path, host.sep)
    const beside = n.dir
      ? joinPath(joinPath(parent, `${base}-shuvix-access-check`, host.sep), SAMPLE_FILE, host.sep)
      : joinPath(parent, OTHER_FILE, host.sep)
    for (const action of ['read', 'write'] as const) {
      // 只有 bot 的策略放行了才说（被它挡回去是应该的，不必一条条列）
      const o = verdictOf(action, pathObject(beside))
      if (overGranted(o)) extra.push(`${action} ${show(beside)} (${o.by})`)
    }
  }

  const homeSample = joinPath(
    joinPath(host.home, 'shuvix-access-check', host.sep),
    SAMPLE_FILE,
    host.sep
  )
  const rootSample = joinPath(
    joinPath(host.root, 'shuvix-access-check', host.sep),
    SAMPLE_FILE,
    host.sep
  )
  const elsewhere: Array<[string, AccessOutcome]> = [
    [
      'read a file in the home folder outside its working folder',
      judge('read', pathObject(homeSample))
    ],
    ['write there', judge('write', pathObject(homeSample))],
    ['write outside the home folder', judge('write', pathObject(rootSample))]
  ]
  // 结果一样的合成一句（大多数时候三条都是同一个 ask）
  const byOutcome = new Map<string, string[]>()
  for (const [what, o] of elsewhere) {
    if (overGranted(o)) continue
    const text = outcomeText(o)
    byOutcome.set(text, [...(byOutcome.get(text) ?? []), what])
  }
  if (byOutcome.size > 0) {
    lines.push(
      `- elsewhere: ${[...byOutcome].map(([text, whats]) => `${whats.join(', ')}: ${text}`).join('; ')}.`
    )
  }
  for (const [what, o] of elsewhere) {
    if (overGranted(o)) extra.push(`${what} (${o.by})`)
  }
  if (extra.length > 0) {
    lines.push(
      `- also allowed, beyond the paths its policies name: ${extra.join('; ')}. ` +
        'Narrow the policy unless the user wants that.'
    )
  }
  if (omitted > 0) {
    lines.push(
      `- ${omitted} more path${omitted === 1 ? '' : 's'} named in its policies ${omitted === 1 ? 'was' : 'were'} not checked.`
    )
  }
  return { lines, stops }
}

/**
 * 回执里的那一段（模型面英文）：每个位置一节（几个位置结果一样就合成一节），身份那一行，
 * 没有策略点名它时再加「先问用户、再配一份策略」那段
 */
export function botAccessNote(input: BotAccessCheckInput): string {
  const sections: Array<{ labels: string[]; lines: string[] }> = []
  let stops = false
  for (const location of input.locations) {
    const result = locationLines(location, input)
    stops ||= result.stops
    const same = sections.find((s) => s.lines.join('\n') === result.lines.join('\n'))
    if (same) same.labels.push(location.label)
    else sections.push({ labels: [location.label], lines: result.lines })
  }

  const out: string[] = []
  const identity = celQuote(input.identity)
  const condition = `has(subject.bot) && subject.bot == ${identity} && subject.agentKind == 'root'`
  for (const section of sections) {
    out.push(
      `Unattended access check for bot ${input.botName} (scheduled runs have nobody to answer asks; ` +
        `as run in ${section.labels.join(' or ')}):`,
      ...section.lines
    )
  }
  out.push(
    `In a policy this bot is \`subject.bot == ${identity}\`` +
      (input.identityFrom === 'id'
        ? ' (its shuvix-id).'
        : input.identityFrom === 'name'
          ? ' — it has no shuvix-id, so policies know it by its name and renaming the bot breaks them.'
          : ' — its shuvix-id is a built-in form that only the bot file ShuviX wrote may carry, so policies know it ' +
            'by its name and renaming the bot breaks them.') +
      (input.naming.length > 0
        ? ` Policies that name it: ${input.naming.map((p) => p.name).join(', ')}.`
        : ' No policy names it.')
  )
  // 写成 allow 的规则：判定照实显示「还是要问」，这里说为什么
  const plainAllows = input.naming.flatMap((policy) =>
    policy.rules.flatMap((rule, i) =>
      rule.effect === 'allow' ? [`${policy.name} rule #${i}`] : []
    )
  )
  if (plainAllows.length > 0) {
    out.push(
      `A plain \`allow\` never overrides an ask, so these rules change nothing above: ${plainAllows.join(', ')} — ` +
        'write `force-allow`.'
    )
  }
  // 按会话 id 放行的规则：写策略那一刻的会话列表，盖不住之后每次运行要读的会话（2026-10-31 真模型演练：「看昨天的
  // 会话」被写成了当时那一场会话的 id，核对照实说「还是要问」，模型却没看出为什么）
  const bySessionId = input.naming.flatMap((policy) =>
    policy.rules.flatMap((rule, i) =>
      (rule.effect === 'force-allow' || rule.effect === 'allow') &&
      /\bobject\.sessionId\b/.test(rule.match ?? '')
        ? [`${policy.name} rule #${i}`]
        : []
    )
  )
  if (bySessionId.length > 0) {
    out.push(
      `These rules pick sessions by \`object.sessionId\`: ${bySessionId.join(', ')}. A scheduled run reads ` +
        'sessions that do not exist yet when the policy is written (the check above uses a new one), so a list of ' +
        'ids never covers them — match by age (`object.lastActiveAt`) or leave the session condition out.'
    )
  }
  if (stops) {
    out.push(
      'A run that asks something only the user can answer waits until they come back, and that binding’s next ' +
        'firings are skipped while it waits.'
    )
  }
  if (input.naming.length === 0) {
    out.push(
      'If the bot’s job needs any of the above, tell the user what it needs and why, and offer a companion policy ' +
        'for this bot, the way the diary bot has daily-bot-access: one `force-allow` rule per need (a plain `allow` ' +
        `does not override an ask), each matching \`${condition}\` plus the narrowest condition on the object; ` +
        'the policy-md manual entry has the template. Write it into ' +
        `${input.policiesDirLabel} only after the user agrees — the result of that write checks the bot again.`
    )
  }
  const warnings = [...new Set((input.warnings?.() ?? []).map(warningText))].filter(Boolean)
  if (warnings.length > 0) {
    out.push(
      'Some rules failed to evaluate (a failing allow or force-allow rule grants nothing; a failing ask or deny ' +
        `rule still applies): ${warnings.slice(0, MAX_WARNINGS).join('; ')}.`
    )
  }
  return out.join('\n')
}
