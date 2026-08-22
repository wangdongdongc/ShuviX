/**
 * 规则匹配层 —— CEL（Common Expression Language）表达式求值。
 *
 * 匹配语义**只有这一种**：每条策略规则一个 `match` 表达式，对整份请求文档求值
 * （旧的结构化匹配器 action/subject/tool/environment/object 已全部并入 match ——
 * 引擎不再自带任何逐要素匹配逻辑）。为什么是 CEL：非图灵完备、保证终止、无副作用，
 * 就是为"策略条件"设计的安全画像（K8s 准入控制 / Envoy / Firebase 规则同款）；
 * 实现选 @marcbachmann/cel-js（零依赖纯 JS，两端可内联）。
 *
 * 求值上下文（请求文档，见 types.ts MatchContext）：
 *   subject   { kind, agentKind, profile, sessionId, depth }
 *   action    'read' | 'write' | 'execute' | …
 *   tool      { name, operation }（非工具路径为空串 —— tool 是固定命名空间，恒可访问）
 *   object    开放属性文档：{ type } + 各 PEP 上报的属性（path / command / gitAction…）
 *   env       { host, platform }
 *   vars      宿主变量表（workspace / home / skillsDirs…）
 *   （策略级 lets 的求值结果以顶层名字额外注入 —— 见 assemble.ts）
 * 注入函数：
 *   hasShortFlags(argv, 'rf')  argv 里是否带齐这些 GNU 短选项（认 `-rf` / `-fr` / `-r -f`）
 *   inDir(p, dirs)  路径段边界的目录包含判定（dirs 接受字符串或字符串列表；
 *                   语义与 allowList 前缀匹配一致，/foo 不命中 /foobar，绑定平台 sep；
 *                   空串目录恒不命中 —— '' + sep 会前缀命中一切绝对路径，必须挡掉）
 *
 * **strict 语义**：object 是开放属性文档，访问缺失属性（如对 command 客体取
 * `object.path`）按 CEL 语义报错，由 evaluate 按规则 effect fail-safe 处置
 * （deny/ask 视为命中 + 告警，allow 视为不命中）—— 保护宁可多拦一次，绝不静默蒸发。
 * 惯用法：每条规则以 `object.type == '…'` 开头做类型守卫（CEL 的 && / || 会吸收
 * 另一侧已定值时的错误，守卫写在哪个位置都有效，但写在前面最可读）。
 * PEP 侧的对偶约定：构造某 type 的属性文档时，该 type 的全部已知属性都要给值
 * （布尔缺省 false、字符串缺省空串）—— strict 只用于跨 type 的误引用。
 *
 * 时机与错误处置：
 *   - 语法校验在策略文件解析时（compileMatch）：语法错 → 整份文件非法（严格哲学）；
 *   - 求值在 evaluate 内（evaluateMatch）：编译产物按 (sep, 表达式) 缓存；
 *     求值错误/非布尔结果 throw，由调用方 fail-safe 处置。
 */
import { Environment } from '@marcbachmann/cel-js'
import { matchesPathEntry } from './allowEntries'
import type { PolicyVarValue } from './types'

interface SepEnvironment {
  env: Environment
  /** 表达式 → 预编译求值函数 */
  cache: Map<string, (context: Record<string, unknown>) => unknown>
}

/** inDir 语义绑定平台 sep → 每个 sep 一个 Environment（现实中只有 '/' 与 '\\' 两个） */
const environments = new Map<string, SepEnvironment>()

function environmentFor(sep: string): SepEnvironment {
  let entry = environments.get(sep)
  if (!entry) {
    // unlistedVariablesAreDyn：策略级 lets 的名字是动态的，无法预注册 ——
    // 未知名字到求值期才抛（No such key / Unknown variable），由 fail-safe 兜底
    const env = new Environment({ unlistedVariablesAreDyn: true })
      .registerFunction('inDir(string, dyn): bool', (p: string, dirs: unknown): boolean => {
        const list = Array.isArray(dirs) ? dirs : [dirs]
        return list.some(
          (dir) => typeof dir === 'string' && dir !== '' && matchesPathEntry(dir, p, sep)
        )
      })
      /**
       * argv 里是否带齐 want 中的每一个 GNU 短选项 —— `-rf` / `-fr` / `-r -f` 都算。
       *
       * 「短选项簇」按 GNU 约定识别：单横线 + 纯字母。这是**命令特定**的约定，
       * find 的 `-delete`、dd 的 `of=` 都不遵守它，所以引擎不做通用 flag 归一化
       * （那会把 `-delete` 拆成 d,e,l,e,t,e），而是把「这条命令按不按 GNU 风格解析」
       * 留给写规则的人判断 —— 与 inDir 同类的接缝。
       */
      .registerFunction('hasShortFlags(dyn, string): bool', (argv: unknown, want: string) => {
        const list = Array.isArray(argv) ? argv : []
        const clusters = list.filter(
          (a): a is string => typeof a === 'string' && /^-[A-Za-z]+$/.test(a)
        )
        return [...want].every((flag) => clusters.some((c) => c.slice(1).includes(flag)))
      })
    entry = { env, cache: new Map() }
    environments.set(sep, entry)
  }
  return entry
}

/**
 * 语法校验（策略文件解析时调用）。语法与 sep 无关，用 '/' 环境编译即可。
 * 返回 null = 合法；字符串 = 错误消息（调用方将整份文件判非法）。
 * 只校验语法不校验标识符 —— 未知变量/函数留给求值期（fail-safe 处置）。
 */
export function compileMatch(expression: string): string | null {
  try {
    environmentFor('/').env.parse(expression)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * 求值 match 表达式。要求结果为严格布尔 —— 非布尔视为错误 throw，
 * 由调用方按规则 effect 做 fail-safe 处置。doc = 请求文档（+ lets 顶层注入）。
 */
export function evaluateMatch(
  expression: string,
  doc: Record<string, unknown>,
  sep: string
): boolean {
  const { env, cache } = environmentFor(sep)
  let program = cache.get(expression)
  if (!program) {
    program = env.parse(expression)
    cache.set(expression, program)
  }
  const result = program(doc)
  if (typeof result !== 'boolean') {
    throw new Error(`match expression must evaluate to a boolean, got ${typeof result}`)
  }
  return result
}

/**
 * 求值一条策略级 let 绑定（值表达式，结果任意类型）。
 * 上下文只有 {vars}（装配期无请求可看）；错误向上抛，由 assemble 记警告
 * （该 let 名字缺失 → 引用它的规则求值报错 → 按规则 effect fail-safe）。
 */
export function evaluateLet(
  expression: string,
  vars: Record<string, PolicyVarValue>,
  sep: string
): unknown {
  const { env, cache } = environmentFor(sep)
  let program = cache.get(expression)
  if (!program) {
    program = env.parse(expression)
    cache.set(expression, program)
  }
  return program({ vars })
}
