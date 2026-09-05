/**
 * 工作流定义文件（<name>.md，`shuvix: workflow v1`）解析 —— 设计见
 * docs/workflow-md-design.md §2。与 agent/policy 文件平行的独立格式：
 *
 *  - 首键 `shuvix: workflow v1` 是文件类型标记，**读取时必需**（有意区别于 agent/policy
 *    的「读取可选」：本格式没有历史存量，缺标记只可能是误投 —— 比如普通笔记被丢进
 *    workflows 目录）；
 *  - `name` / `description` / `shuvix-displayName` / `shuvix-builtin` 同 agent md 语义；
 *  - `shuvix-workflow-on`：自动触发绑定数组，每条 `{trigger, when?, ...params}` ——
 *    `when` 为 CEL（上下文 {event, vars, env}，语法错整份非法）；已知埋点的参数键须在
 *    其 bindingParamKeys 内；**未知埋点 id 不判非法**（绑定惰性化 + warn）——埋点词汇表
 *    是逐版本增补的开放集合，两端埋点天然不同，判非法会让每个新埋点炸掉旧安装上的同一份文件；
 *  - `shuvix-workflow-input`：手动/API 调用入参的 JSON Schema（顶层须 type:'object'）；
 *  - `shuvix-workflow-vars`：常量表（注入脚本 `vars` 与 when 的 `vars`）；
 *  - `shuvix-workflow-limits` / `shuvix-workflow-concurrency`：限额与重入策略；
 *  - 正文 = 文档散文 + 具名围栏代码块（**行首**围栏，info string 判别）：
 *      · ```js workflow（或 javascript workflow）—— 编排脚本，必须恰好一个；
 *      · ```json schema=<name> —— 具名 JSON Schema，脚本经 schemas.<name> 引用；
 *      · ```md prompt=<name> —— 具名提示词模板，脚本经 prompt('<name>') 取渲染后的字符串；
 *      · 其余块与散文都是纯文档，引擎不评估。
 *
 * 解析哲学与 agent/policy 一致：结构非法**整份拒绝**（null + warn 人读原因）。
 * 裸键 `on`/`input`/`vars` 与未知的 `shuvix-workflow-*` 键同判非法（写了错键名的文件
 * 被静默判「无绑定」会让用户误信工作流生效）；无前缀的陌生键忽略（给其他应用留活口）。
 * 脚本**语法**不在此校验 —— 校验器是宿主注入的脚本引擎（compile），本解析器保持两端可用。
 * 暂无序列化器：工作流没有编辑 GUI，用户文件手写、内置文件随包（需要时再补，与 agent md 同形）。
 */
import { parse as parseYaml } from 'yaml'
import {
  WORKFLOW_CONCURRENCY_KEY,
  WORKFLOW_CONCURRENCY_MODES
} from '@shuvix/chat-protocol/shuvixMdDescriptors'
import { splitFrontmatter } from '../markdownFrontmatter'
import { getTriggerPoint } from './triggerPoints'
import { compileWhen } from './when'
import { promptIncludes } from './promptTemplate'

export const WORKFLOW_FILE_MARKER_KEY = 'shuvix'
export const WORKFLOW_FILE_MARKER = 'workflow v1'

export const WORKFLOW_ON_KEY = 'shuvix-workflow-on'
export const WORKFLOW_INPUT_KEY = 'shuvix-workflow-input'
export const WORKFLOW_VARS_KEY = 'shuvix-workflow-vars'
export const WORKFLOW_LIMITS_KEY = 'shuvix-workflow-limits'
export { WORKFLOW_CONCURRENCY_KEY } from '@shuvix/chat-protocol/shuvixMdDescriptors'

/** 本格式认识的全部 `shuvix-workflow-*` 键 —— 其余同前缀键判整份非法（防"以为生效"） */
const WORKFLOW_KEYS = new Set([
  WORKFLOW_ON_KEY,
  WORKFLOW_INPUT_KEY,
  WORKFLOW_VARS_KEY,
  WORKFLOW_LIMITS_KEY,
  WORKFLOW_CONCURRENCY_KEY
])

/** 裸键（丢了前缀的旧写法/他家方言）→ 整份非法，同 policy md 对裸 rules/lets/scope 的处置 */
const BARE_KEYS = ['on', 'input', 'vars'] as const

export type WorkflowConcurrency = (typeof WORKFLOW_CONCURRENCY_MODES)[number]

/** 限额覆盖（缺省值在引擎侧，见 engine.ts DEFAULT_WORKFLOW_LIMITS） */
export interface WorkflowLimits {
  maxAgents?: number
  maxDurationSec?: number
  maxConcurrentAgents?: number
  askTimeoutSec?: number
}
const LIMIT_KEYS = new Set(['maxAgents', 'maxDurationSec', 'maxConcurrentAgents', 'askTimeoutSec'])

/** 一条触发绑定；params 为埋点自己声明的额外参数（已按 bindingParamKeys 校验） */
export interface WorkflowTriggerBinding {
  trigger: string
  /** CEL 过滤（上下文 {event, vars, env}）；省略 = 恒命中 */
  when?: string
  /**
   * 分道键的 CEL（同一上下文）—— 同一工作流内**相同键**的 run 才互斥，
   * 撞车时怎么办由文件的 `shuvix-workflow-concurrency` 决定。
   * 省略 = 按埋点 scope 推导（见 engine.ts）。
   */
  key?: string
  params: Record<string, unknown>
}

export interface ParsedWorkflowFile {
  name: string
  displayName: string
  description: string
  bindings: WorkflowTriggerBinding[]
  /** `shuvix-workflow-input`（顶层 type:'object'）；省略 = 不接受入参 */
  inputSchema?: Record<string, unknown>
  vars: Record<string, unknown>
  limits: WorkflowLimits
  concurrency: WorkflowConcurrency
  /** 编排脚本（```js workflow 块原文；语法校验在宿主脚本引擎） */
  script: string
  /** 具名 schema 块：name → JSON Schema（顶层已校验为 object） */
  schemas: Record<string, Record<string, unknown>>
  /**
   * 具名提示词块：name → 模板原文（`{{path}}` 在 `prompt()` 取用时渲染）。
   * 提示词是文案不是程序 —— 放在 md 块里可读可改，脚本因此只剩流程（见 promptTemplate.ts）。
   */
  prompts: Record<string, string>
}

/** 行首围栏代码块提取（不支持缩进围栏 —— 机器块要求顶格，缩进的按文档散文处理） */
interface FencedBlock {
  info: string
  content: string
}
function extractFencedBlocks(body: string): FencedBlock[] {
  const lines = body.split(/\r?\n/)
  const blocks: FencedBlock[] = []
  let i = 0
  while (i < lines.length) {
    const open = /^(`{3,})(.*)$/.exec(lines[i])
    if (!open) {
      i++
      continue
    }
    const fenceLen = open[1].length
    const content: string[] = []
    let j = i + 1
    let closed = false
    for (; j < lines.length; j++) {
      const close = /^(`{3,})\s*$/.exec(lines[j])
      if (close && close[1].length >= fenceLen) {
        closed = true
        break
      }
      content.push(lines[j])
    }
    // 未闭合围栏按 CommonMark 语义延伸到文件末尾
    blocks.push({ info: open[2].trim(), content: content.join('\n') })
    i = closed ? j + 1 : j
  }
  return blocks
}

const SCRIPT_INFO_RE = /^(?:js|javascript)\s+workflow$/
const SCHEMA_INFO_RE = /^json\s+schema=([A-Za-z_][A-Za-z0-9_-]*)$/
/** 提示词块：`md prompt=<name>`，脚本里以 `prompt('<name>')` 取用（渲染后的字符串） */
const PROMPT_INFO_RE = /^(?:md|markdown)\s+prompt=([A-Za-z_][A-Za-z0-9_-]*)$/

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 解析工作流定义 markdown。结构非法返回 null，原因经 `warn`（与 agent/policy 解析器同形同策）。
 * `defaultName` 为文件 basename（frontmatter `name` 可覆盖）。
 */
export function parseWorkflowDefinitionFile(
  raw: string,
  defaultName: string,
  warn?: (msg: string) => void
): ParsedWorkflowFile | null {
  const rejectAs = (who: string, why: string): null => {
    warn?.(`workflow '${who}': ${why}; the whole file is rejected`)
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
  const marker = fields[WORKFLOW_FILE_MARKER_KEY]
  if (typeof marker !== 'string' || !/^workflow(\s+v\d+)?$/.test(marker.trim())) {
    return reject(`missing file marker '${WORKFLOW_FILE_MARKER_KEY}: ${WORKFLOW_FILE_MARKER}'`)
  }

  // ── 键集纪律：裸键与未知前缀键整份非法 ──
  for (const bare of BARE_KEYS) {
    if (bare in fields) {
      return reject(`bare '${bare}' key is not read — use 'shuvix-workflow-${bare}'`)
    }
  }
  for (const key of Object.keys(fields)) {
    if (key.startsWith('shuvix-workflow-') && !WORKFLOW_KEYS.has(key)) {
      return reject(`unknown key '${key}' (allowed: ${[...WORKFLOW_KEYS].join(', ')})`)
    }
  }

  // ── 触发绑定 ──
  const onRaw = fields[WORKFLOW_ON_KEY] ?? null
  const bindings: WorkflowTriggerBinding[] = []
  if (onRaw !== null) {
    if (!Array.isArray(onRaw)) return reject(`'${WORKFLOW_ON_KEY}' must be a list of bindings`)
    for (const entry of onRaw) {
      if (!isMapping(entry)) return reject(`'${WORKFLOW_ON_KEY}' entries must be mappings`)
      const trigger = typeof entry.trigger === 'string' ? entry.trigger.trim() : ''
      if (!trigger) return reject(`each '${WORKFLOW_ON_KEY}' entry needs a 'trigger' id`)
      let when: string | undefined
      if (entry.when !== undefined) {
        if (typeof entry.when !== 'string' || !entry.when.trim()) {
          return reject(`binding '${trigger}': 'when' must be a CEL expression string`)
        }
        when = entry.when.trim()
        const celError = compileWhen(when)
        if (celError) return reject(`binding '${trigger}': invalid when CEL — ${celError}`)
      }
      // 分道键：**「什么和什么算同一件事」由订阅方决定**，引擎不猜维度。
      // 省略 → 由埋点 scope 推导（会话域埋点即 event.sessionId，其余全局一条道）。
      // 写 `key: "'shared'"`（CEL 字符串字面量）可要回旧的「整份文件一条道」语义。
      let key: string | undefined
      if (entry.key !== undefined) {
        if (typeof entry.key !== 'string' || !entry.key.trim()) {
          return reject(`binding '${trigger}': 'key' must be a CEL expression string`)
        }
        key = entry.key.trim()
        const keyError = compileWhen(key)
        if (keyError) return reject(`binding '${trigger}': invalid key CEL — ${keyError}`)
      }
      const params: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(entry)) {
        if (k === 'trigger' || k === 'when' || k === 'key') continue
        params[k] = v
      }
      const def = getTriggerPoint(trigger)
      if (def) {
        for (const k of Object.keys(params)) {
          if (!def.bindingParamKeys.includes(k)) {
            return reject(
              `binding '${trigger}': unknown param '${k}'` +
                (def.bindingParamKeys.length
                  ? ` (allowed: ${def.bindingParamKeys.join(', ')})`
                  : ' (this trigger takes no params)')
            )
          }
        }
      } else {
        // 未知埋点 id：绑定惰性化（引擎按 id 匹配，未知 id 自然不触发）——见文件头注释
        warn?.(
          `workflow '${name}': trigger '${trigger}' is not known on this build — binding is inert`
        )
      }
      bindings.push({ trigger, when, key, params })
    }
  }

  // ── 入参 schema / 常量表 / 模型 ──
  const inputRaw = fields[WORKFLOW_INPUT_KEY] ?? null
  let inputSchema: Record<string, unknown> | undefined
  if (inputRaw !== null) {
    if (!isMapping(inputRaw) || inputRaw.type !== 'object') {
      return reject(
        `'${WORKFLOW_INPUT_KEY}' must be a JSON Schema mapping with top-level type: object`
      )
    }
    inputSchema = inputRaw
  }

  const varsRaw = fields[WORKFLOW_VARS_KEY] ?? null
  if (varsRaw !== null && !isMapping(varsRaw)) {
    return reject(`'${WORKFLOW_VARS_KEY}' must be a mapping`)
  }

  // ── 限额 / 重入 ──
  const limitsRaw = fields[WORKFLOW_LIMITS_KEY] ?? null
  const limits: WorkflowLimits = {}
  if (limitsRaw !== null) {
    if (!isMapping(limitsRaw)) return reject(`'${WORKFLOW_LIMITS_KEY}' must be a mapping`)
    for (const [k, v] of Object.entries(limitsRaw)) {
      if (!LIMIT_KEYS.has(k)) {
        return reject(
          `'${WORKFLOW_LIMITS_KEY}': unknown key '${k}' (allowed: ${[...LIMIT_KEYS].join(', ')})`
        )
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        return reject(`'${WORKFLOW_LIMITS_KEY}.${k}' must be a positive number`)
      }
      ;(limits as Record<string, number>)[k] = v
    }
  }

  const concurrencyRaw = fields[WORKFLOW_CONCURRENCY_KEY] ?? null
  if (
    concurrencyRaw !== null &&
    !(WORKFLOW_CONCURRENCY_MODES as readonly unknown[]).includes(concurrencyRaw)
  ) {
    return reject(
      `'${WORKFLOW_CONCURRENCY_KEY}' must be one of: ${WORKFLOW_CONCURRENCY_MODES.join(' | ')}`
    )
  }

  // ── 正文块：恰一个脚本块 + 具名 schema / prompt 块 ──
  let script: string | undefined
  const schemas: Record<string, Record<string, unknown>> = {}
  const prompts: Record<string, string> = {}
  for (const block of extractFencedBlocks(split.body)) {
    if (SCRIPT_INFO_RE.test(block.info)) {
      if (script !== undefined)
        return reject('multiple `js workflow` script blocks — exactly one is required')
      script = block.content
      continue
    }
    // `json schema` 形状但整体不合规（名字非法 / `= ` 带空格 / 缺名）→ 整份非法：
    // 静默当散文会让脚本读 `schemas.<name>` 悄悄得 undefined —— 与裸键同一「防以为生效」纪律
    if (/^json\s+schema\b/.test(block.info) && !SCHEMA_INFO_RE.test(block.info)) {
      return reject(
        `schema block info string '${block.info}' is invalid — expected \`json schema=<name>\` with <name> matching [A-Za-z_][A-Za-z0-9_-]*`
      )
    }
    const schemaMatch = SCHEMA_INFO_RE.exec(block.info)
    if (schemaMatch) {
      const schemaName = schemaMatch[1]
      if (schemaName in schemas) return reject(`duplicate schema block '${schemaName}'`)
      let parsed: unknown
      try {
        parsed = JSON.parse(block.content)
      } catch (e) {
        return reject(
          `schema block '${schemaName}': invalid JSON (${e instanceof Error ? e.message : e})`
        )
      }
      if (!isMapping(parsed) || parsed.type !== 'object') {
        return reject(
          `schema block '${schemaName}' must be a JSON Schema with top-level type: object`
        )
      }
      schemas[schemaName] = parsed
      continue
    }
    // `md prompt` 形状但整体不合规 → 整份非法（同 schema 块：静默当散文会让脚本
    // 读 `prompt('<name>')` 悄悄拿到空串）
    if (/^(?:md|markdown)\s+prompt\b/.test(block.info) && !PROMPT_INFO_RE.test(block.info)) {
      return reject(
        `prompt block info string '${block.info}' is invalid — expected \`md prompt=<name>\` with <name> matching [A-Za-z_][A-Za-z0-9_-]*`
      )
    }
    const promptMatch = PROMPT_INFO_RE.exec(block.info)
    if (promptMatch) {
      const promptName = promptMatch[1]
      if (promptName in prompts) return reject(`duplicate prompt block '${promptName}'`)
      prompts[promptName] = block.content
      continue
    }
    // 其余 info string 的块是纯文档，跳过
  }
  if (script === undefined || !script.trim()) {
    return reject('missing the `js workflow` script block — exactly one is required')
  }
  // 块之间的 `{{>name}}` 引用：指向不存在的块、或引用成环 → 整份非法。与 schema 块同一条
  // 纪律 —— 渲染期静默成空会让 prompt() 悄悄少一段，而模型只会「答得不太对」
  const includeError = checkPromptIncludes(prompts)
  if (includeError) return reject(includeError)

  return {
    name,
    displayName: stringField(fields, 'shuvix-displayName') ?? name,
    description: stringField(fields, 'description') ?? '',
    bindings,
    inputSchema,
    vars: (varsRaw as Record<string, unknown> | null) ?? {},
    limits,
    concurrency: (concurrencyRaw as WorkflowConcurrency | null) ?? 'skip',
    script,
    schemas,
    prompts
  }
}

/**
 * prompt 块之间的 `{{>name}}` 引用校验：指向不存在的块、或引用成环 → 人读原因；合法 → null。
 * 成环检测是三色 DFS，报的是整条环路（`a -> b -> a`），读到就知道该断哪一条。
 */
function checkPromptIncludes(prompts: Record<string, string>): string | null {
  const refs = new Map<string, string[]>()
  for (const [name, template] of Object.entries(prompts)) {
    const includes = promptIncludes(template)
    for (const ref of includes) {
      if (!(ref in prompts)) {
        return `prompt block '${name}' includes unknown prompt block '${ref}' — add a \`\`\`md prompt=${ref} block or fix the reference`
      }
    }
    refs.set(name, includes)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const walk = (name: string, path: string[]): string[] | null => {
    const seen = state.get(name)
    if (seen === 'done') return null
    if (seen === 'visiting') return [...path, name]
    state.set(name, 'visiting')
    for (const ref of refs.get(name) ?? []) {
      const cycle = walk(ref, [...path, name])
      if (cycle) return cycle
    }
    state.set(name, 'done')
    return null
  }
  for (const name of refs.keys()) {
    const cycle = walk(name, [])
    if (cycle) {
      // 只报环本身：从第一次出现被重复的那个名字截起
      const start = cycle.indexOf(cycle[cycle.length - 1])
      return `prompt blocks include each other in a cycle: ${cycle.slice(start).join(' -> ')}`
    }
  }
  return null
}
