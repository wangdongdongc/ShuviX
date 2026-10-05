/**
 * 严格 JSON 守卫 —— 进复制状态（SessionView / AgentView）的值必须是**纯 JSON**：有限数、
 * 普通对象 / 稠密普通数组、没有 `undefined` 值、没有 getter、没有环。
 *
 * 判据与 chord 的 `isJsonValue` 逐条相同（P3-01-08 用 chord 对照钉住），但 chat-protocol 不依赖
 * chord：协议包要能被不装 chord 的消费方（外部 agent 服务器）原样引用。`assertJsonOnly` 额外
 * 报出**第一处**违规的路径（`messages[0].metadata.usage`），排查时不必二分。
 */

/** 第一处违规：路径（根为 `''`）与原因 */
export interface JsonOnlyViolation {
  readonly path: string
  readonly reason: string
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'function') return 'a function'
  if (typeof value === 'bigint') return 'a bigint'
  if (typeof value === 'symbol') return 'a symbol'
  return typeof value
}

function child(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? path === ''
      ? key
      : `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`
}

function check(
  value: unknown,
  path: string,
  ancestors: Set<object>
): JsonOnlyViolation | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : { path, reason: `non-finite number ${value}` }
  }
  if (typeof value !== 'object') return { path, reason: describe(value) }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return { path, reason: 'array with a non-standard prototype' }
    }
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) return { path, reason: 'symbol key' }
    if (keys.length !== value.length + 1) {
      return { path, reason: 'sparse array or array with extra properties' }
    }
    if (ancestors.has(value)) return { path, reason: 'cycle' }
    ancestors.add(value)
    try {
      for (let index = 0; index < value.length; index++) {
        const at = `${path}[${index}]`
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined) return { path: at, reason: 'hole' }
        if (!descriptor.enumerable || !('value' in descriptor)) {
          return { path: at, reason: 'non-enumerable or accessor property' }
        }
        const failure = check(descriptor.value, at, ancestors)
        if (failure !== undefined) return failure
      }
      return undefined
    } finally {
      ancestors.delete(value)
    }
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return { path, reason: 'not a plain object' }
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) {
    return { path, reason: 'symbol key' }
  }
  if (ancestors.has(value)) return { path, reason: 'cycle' }
  ancestors.add(value)
  try {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      const at = child(path, key)
      if (!descriptor.enumerable || !('value' in descriptor)) {
        return { path: at, reason: 'non-enumerable or accessor property' }
      }
      const failure = check(descriptor.value, at, ancestors)
      if (failure !== undefined) return failure
    }
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

/** 第一处不是严格 JSON 的地方；整个值都是 → undefined */
export function findJsonViolation(value: unknown): JsonOnlyViolation | undefined {
  return check(value, '', new Set())
}

/** 值是不是严格 JSON（与 chord `isJsonValue` 同判据） */
export function isJsonOnly(value: unknown): boolean {
  return findJsonViolation(value) === undefined
}

/** 不是严格 JSON 就抛 TypeError，消息里带 `label` 与第一处违规的路径 */
export function assertJsonOnly(value: unknown, label = 'value'): void {
  const violation = findJsonViolation(value)
  if (violation === undefined) return
  const where =
    violation.path === ''
      ? label
      : violation.path.startsWith('[')
        ? `${label}${violation.path}`
        : `${label}.${violation.path}`
  throw new TypeError(`${where} is not strict JSON: ${violation.reason}`)
}
