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
 *                   Windows 下两侧分隔符先归一为 '/'，见 matchesPathEntry；
 *                   空串目录恒不命中 —— '' + sep 会前缀命中一切绝对路径，必须挡掉；
 *                   非字符串条目（含 null）一律忽略）。
 *                   宿主给了 realPath 时比的是**位置**：p 与每个目录都先解析成真正通向的
 *                   地方再比（见 withRealPaths）—— 只解析 p 的话，凭据目录、工作区这些目录
 *                   本身是链接时就对不上；目录来自 vars、lets 还是字面量都一样，所以只能在这里做
 *
 * **strict 语义**：object 是开放属性文档，访问缺失属性（如对 command 客体取
 * `object.path`）按 CEL 语义报错，由 evaluate 按规则 effect fail-safe 处置
 * （deny/ask 视为命中 + 告警，allow 视为不命中）—— 保护宁可多拦一次，绝不静默蒸发。
 * 惯用法：每条规则以 `object.type == '…'` 开头做类型守卫（CEL 的 && / || 会吸收
 * 另一侧已定值时的错误，守卫写在哪个位置都有效，但写在前面最可读）。
 * PEP 侧的对偶约定：构造某 type 的属性文档时，该 type 的全部已知属性都要给值
 * （布尔缺省 false、字符串缺省空串）—— strict 只用于跨 type 的误引用。
 *
 * **唯一的例外是「宿主没供给的目录变量」**：只以 inDir 目录参数身份出现的 `vars.x`
 * （`inDirOnlyVarNames`）缺失时，由 assemble 替 deny / ask 规则绑定为 null —— inDir 把它当
 * 「没有这个目录」：正向用法因此命中不了，`!inDir(...)` 这种取反用法照常为真（多问而不是少问）。
 * 否则缺键报错会被 fail-safe 当成命中，一条只守一个目录的 force-ask 就成了对每一次写的
 * force-ask。其余位置（拼接、比较、has、lets）不绑定，照 CEL 原语义求值。
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

/**
 * 本次求值里 inDir 用的真实路径解析；求值之外为 null（inDir 退回按写法比较）。
 *
 * 为什么是一个动态作用域的槽而不是参数：cel-js 调注册函数时只给实参（this 是共享的 evaluator），
 * 拿不到求值上下文；而解析器是每次评估现给的（带本次的记忆表）。CEL 求值是同步的，不会有两次
 * 求值交错，所以「evaluate 在规则循环期间设上、结束复原」就是把它递给 inDir 的最小通道。
 */
let activeRealPath: ((path: string) => string) | null = null

/** 在 realPath 生效的作用域里执行 run（可嵌套，结束复原外层的值）；realPath 省略 = 按写法比较 */
export function withRealPaths<T>(
  realPath: ((path: string) => string) | undefined,
  run: () => T
): T {
  const outer = activeRealPath
  activeRealPath = realPath ?? null
  try {
    return run()
  } finally {
    activeRealPath = outer
  }
}

function environmentFor(sep: string): SepEnvironment {
  let entry = environments.get(sep)
  if (!entry) {
    // unlistedVariablesAreDyn：策略级 lets 的名字是动态的，无法预注册 ——
    // 未知名字到求值期才抛（No such key / Unknown variable），由 fail-safe 兜底
    const env = new Environment({ unlistedVariablesAreDyn: true })
      .registerFunction('inDir(string, dyn): bool', (p: string, dirs: unknown): boolean => {
        const list = Array.isArray(dirs) ? dirs : [dirs]
        const real = activeRealPath
        const target = real ? real(p) : p
        return list.some(
          // 空串先挡（解析一个空串会得到某个进程目录），再解析目录本身
          (dir) =>
            typeof dir === 'string' &&
            dir !== '' &&
            matchesPathEntry(real ? real(dir) : dir, target, sep)
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

/** cel-js 的 AST 节点（`parse(expr).ast`）：args 可能是单个节点、节点数组或原始值 */
interface CelNode {
  op: string
  args: unknown
}

const isCelNode = (value: unknown): value is CelNode =>
  typeof value === 'object' && value !== null && typeof (value as { op?: unknown }).op === 'string'

/** 直接子节点（call 节点的实参是 args 里的一个嵌套数组，一并摊平） */
function childNodes(node: CelNode): CelNode[] {
  const out: CelNode[] = []
  const collect = (value: unknown): void => {
    if (isCelNode(value)) out.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
  }
  collect(node.args)
  return out
}

/** `vars.<name>` / `vars['<name>']` 选择节点 → name；其余节点（含非字面量下标）→ null */
function varsFieldOf(node: CelNode): string | null {
  if ((node.op !== '.' && node.op !== '[]') || !Array.isArray(node.args)) return null
  const [target, key] = node.args as unknown[]
  if (!isCelNode(target) || target.op !== 'id' || target.args !== 'vars') return null
  if (node.op === '.') return typeof key === 'string' ? key : null
  return isCelNode(key) && key.op === 'value' && typeof key.args === 'string' ? key.args : null
}

const dirVarNamesCache = new Map<string, readonly string[]>()

/**
 * 表达式里**只**以 inDir 目录参数身份出现的 `vars.<name>`（排序去重）：`inDir(p, vars.x)`、
 * `inDir(p, vars['x'])` 与 `inDir(p, [vars.x, vars.y])` 里的 x / y。同一表达式别处也引用了它
 * （拼接、比较、has…）就不算 —— 那些位置对 null 的语义与 inDir 不同（拼接换一种报错、比较变
 * false、has 由 false 变 true），必须保持 CEL 原语义。
 * 语法错的表达式返回空：它进不了装配（policyFile 已判整份非法）。
 */
export function inDirOnlyVarNames(expression: string): readonly string[] {
  const cached = dirVarNamesCache.get(expression)
  if (cached) return cached
  let ast: unknown
  try {
    ast = (environmentFor('/').env.parse(expression) as unknown as { ast?: unknown }).ast
  } catch {
    ast = undefined
  }
  const dirUses = new Set<string>()
  const otherUses = new Set<string>()
  const visit = (node: CelNode): void => {
    const field = varsFieldOf(node)
    if (field !== null) {
      otherUses.add(field)
      return
    }
    const args = node.args
    if (
      node.op === 'call' &&
      Array.isArray(args) &&
      args[0] === 'inDir' &&
      Array.isArray(args[1])
    ) {
      const [pathArg, dirsArg] = args[1] as unknown[]
      if (isCelNode(pathArg)) visit(pathArg)
      if (isCelNode(dirsArg)) {
        for (const entry of dirsArg.op === 'list' ? childNodes(dirsArg) : [dirsArg]) {
          const dirField = varsFieldOf(entry)
          if (dirField !== null) dirUses.add(dirField)
          else visit(entry)
        }
      }
      return
    }
    childNodes(node).forEach(visit)
  }
  if (isCelNode(ast)) visit(ast)
  const names = [...dirUses].filter((name) => !otherUses.has(name)).sort()
  dirVarNamesCache.set(expression, names)
  return names
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
