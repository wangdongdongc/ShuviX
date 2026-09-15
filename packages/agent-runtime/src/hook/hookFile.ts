/**
 * Hook 定义文件（<name>.md，`shuvix: hook v1`）解析 —— 设计见 docs/hook-design.md。
 *
 * 一份 hook 说的只有一句话：「在哪些埋点、满足什么条件时，把哪个 agent 叫起来，并对它说这段话」。
 *
 *  - 首键 `shuvix: hook v1` 是文件类型标记，**读取时必需**（本格式没有历史存量，缺标记只可能
 *    是误投 —— 比如普通笔记被丢进 hooks 目录）；读取对版本宽容（`hook` / `hook v2` 也认）；
 *  - `name` / `description` / `shuvix-displayName` / `shuvix-builtin` 同 agent md 语义；
 *  - `shuvix-hook-agent`：要派发的 agent md 名（内置或 `~/.shuvix/agents/` 下的），必填；
 *    四个基座档案（work / chat / notebook / bot）不可点名 —— 它们是会话人格，不是任务 agent，
 *    与派发工具、子会话 `agent_profile` 同一条纪律；
 *  - `shuvix-hook-on`：绑定列表，至少一条，每条 `{trigger, when?}` —— `when` 为 CEL
 *    （上下文 {event, env}，语法错整份非法）；绑定里没有别的键。**未知埋点 id 不判非法**
 *    （绑定惰性化 + warn）——埋点词汇表是逐版本增补的开放集合，两端埋点天然不同，判非法会让
 *    每个新埋点炸掉旧安装上的同一份文件；
 *  - 正文 = 派发给 agent 的任务文本，纯文字、没有占位符 —— 事件由 runner 以 YAML 附在它后面
 *    （hookPrompt.ts）。正文可以为空：agent md 自己就说清了要做什么的时候，事件本身就是任务。
 *
 * 解析哲学与 agent/policy 一致：结构非法**整份拒绝**（null + warn 人读原因）。裸键 `on`/`agent`
 * 与未知的 `shuvix-hook-*` 键同判非法（写了错键名的文件被静默判「无绑定」会让用户误信 hook 生效）；
 * 无前缀的陌生键忽略（给其他应用留活口）。
 */
import { parse as parseYaml } from 'yaml'
import { splitFrontmatter } from '../markdownFrontmatter'
import { BASE_PROFILE_NAMES } from '../subagent/builtinAgents'
import { getTriggerPoint } from './triggerPoints'
import { compileWhen } from './when'

export const HOOK_FILE_MARKER_KEY = 'shuvix'
export const HOOK_FILE_MARKER = 'hook v1'

export const HOOK_ON_KEY = 'shuvix-hook-on'
export const HOOK_AGENT_KEY = 'shuvix-hook-agent'

/** 本格式认识的全部 `shuvix-hook-*` 键 —— 其余同前缀键判整份非法（防"以为生效"） */
const HOOK_KEYS = new Set([HOOK_ON_KEY, HOOK_AGENT_KEY])

/** 裸键（丢了前缀的旧写法/他家方言）→ 整份非法，同 policy md 对裸 rules/lets/scope 的处置 */
const BARE_KEYS = ['on', 'agent'] as const

/** 一条触发绑定 */
export interface HookBinding {
  trigger: string
  /** CEL 过滤（上下文 {event, env}）；省略 = 恒命中 */
  when?: string
}

export interface ParsedHookFile {
  name: string
  displayName: string
  description: string
  /** 要派发的 agent 名（存在与否在派发时由宿主解析） */
  agent: string
  bindings: HookBinding[]
  /** 正文原文（已 trim）：派发给 agent 的任务文本；可为空 */
  prompt: string
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 解析 hook 定义 markdown。结构非法返回 null，原因经 `warn`（与 agent/policy 解析器同形同策）。
 * `defaultName` 为文件 basename（frontmatter `name` 可覆盖）。
 */
export function parseHookDefinitionFile(
  raw: string,
  defaultName: string,
  warn?: (msg: string) => void
): ParsedHookFile | null {
  const rejectAs = (who: string, why: string): null => {
    warn?.(`hook '${who}': ${why}; the whole file is rejected`)
    return null
  }

  const split = splitFrontmatter(raw)
  if (!split) return rejectAs(defaultName, 'no YAML frontmatter block')

  let fields: Record<string, unknown>
  try {
    const parsed: unknown = parseYaml(split.yaml)
    if (parsed === null || parsed === undefined) fields = {}
    else if (isMapping(parsed)) fields = parsed
    else return rejectAs(defaultName, 'frontmatter must be a mapping')
  } catch (e) {
    return rejectAs(defaultName, `invalid YAML (${e instanceof Error ? e.message : e})`)
  }

  const name = stringField(fields, 'name') ?? defaultName
  const reject = (why: string): null => rejectAs(name, why)

  // ── 文件类型标记：必需 ──
  const marker = fields[HOOK_FILE_MARKER_KEY]
  if (typeof marker !== 'string' || !/^hook(\s+v\d+)?$/.test(marker.trim())) {
    return reject(`missing file marker '${HOOK_FILE_MARKER_KEY}: ${HOOK_FILE_MARKER}'`)
  }

  // ── 键集纪律：裸键与未知前缀键整份非法 ──
  for (const bare of BARE_KEYS) {
    if (bare in fields) {
      return reject(`bare '${bare}' key is not read — use 'shuvix-hook-${bare}'`)
    }
  }
  for (const key of Object.keys(fields)) {
    if (key.startsWith('shuvix-hook-') && !HOOK_KEYS.has(key)) {
      return reject(`unknown key '${key}' (allowed: ${[...HOOK_KEYS].join(', ')})`)
    }
  }

  // ── 派发的 agent：必填，且不能是基座 ──
  const agentRaw = fields[HOOK_AGENT_KEY]
  if (agentRaw === undefined || agentRaw === null) {
    return reject(`missing '${HOOK_AGENT_KEY}' — name the agent this hook dispatches`)
  }
  if (typeof agentRaw !== 'string' || !agentRaw.trim()) {
    return reject(`'${HOOK_AGENT_KEY}' must be a non-empty agent name`)
  }
  const agent = agentRaw.trim()
  if (BASE_PROFILE_NAMES.has(agent)) {
    return reject(
      `'${HOOK_AGENT_KEY}: ${agent}' names a session base profile — bases are session personas and cannot be dispatched; name a task agent such as titler or explore`
    )
  }

  // ── 触发绑定：至少一条 ──
  const onRaw = fields[HOOK_ON_KEY]
  if (onRaw === undefined || onRaw === null) {
    return reject(`missing '${HOOK_ON_KEY}' — a hook needs at least one trigger binding`)
  }
  if (!Array.isArray(onRaw) || onRaw.length === 0) {
    return reject(`'${HOOK_ON_KEY}' must be a non-empty list of bindings`)
  }
  const bindings: HookBinding[] = []
  for (const entry of onRaw) {
    if (!isMapping(entry)) return reject(`'${HOOK_ON_KEY}' entries must be mappings`)
    const trigger = typeof entry.trigger === 'string' ? entry.trigger.trim() : ''
    if (!trigger) return reject(`each '${HOOK_ON_KEY}' entry needs a 'trigger' id`)
    for (const k of Object.keys(entry)) {
      if (k !== 'trigger' && k !== 'when') {
        return reject(
          `binding '${trigger}': unknown key '${k}' — a binding has only trigger and when`
        )
      }
    }
    // `when:` 留空 / `~`（YAML null）= 没写条件，与省略同义
    let when: string | undefined
    if (entry.when !== undefined && entry.when !== null) {
      if (typeof entry.when !== 'string' || !entry.when.trim()) {
        return reject(`binding '${trigger}': 'when' must be a CEL expression string`)
      }
      when = entry.when.trim()
      const celError = compileWhen(when)
      if (celError) return reject(`binding '${trigger}': invalid when CEL — ${celError}`)
    }
    if (!getTriggerPoint(trigger)) {
      // 未知埋点 id：绑定惰性化（runner 按 id 匹配，未知 id 自然不触发）——见文件头注释
      warn?.(`hook '${name}': trigger '${trigger}' is not known on this build — binding is inert`)
    }
    bindings.push(when === undefined ? { trigger } : { trigger, when })
  }

  return {
    name,
    displayName: stringField(fields, 'shuvix-displayName') ?? name,
    description: stringField(fields, 'description') ?? '',
    agent,
    bindings,
    prompt: split.body.trim()
  }
}
