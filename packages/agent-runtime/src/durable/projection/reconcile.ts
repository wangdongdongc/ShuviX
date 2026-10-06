/**
 * 逐字段对齐（P3-03）—— 把一份新算出的视图写进复制状态的草稿，**只写变了的地方**。
 *
 * chord 的操作来自赋值（`delta/tracker` 的 `emitChangedValue`）：一个保留前缀、变长了的字符串 → 追加
 * `["a", path, 后缀]`；有重叠 → 截断 + 追加；相等的容器 → 什么都不发；其余 → `["s", path, 值]`。
 * 所以投影不能整块换掉数组 / 对象（那会把流式的每一帧都变成整张卡的 `s`），而要沿着两棵树往下走：
 *
 *  - **对象**：新值里没有的键删掉；两边都是同种容器 → 递归；否则值不同才赋值。
 *  - **数组**：元素都带身份（`id` / `submissionId` 字段，消息、询问、队列）时按身份对齐 —— 共同前缀
 *    逐个递归，前缀之后的那一段用一次 `splice` 换掉（追加就是一次 `push`，两者都是一条 `p` 操作）；
 *    没有身份（卡片的块、图片）时按下标对齐，多出来的 `push`、少了的 `splice` 截掉。
 *
 * 结果：草稿的值与 `next` 深相等（调用方的不变量）；流式文字是 `a`，工具状态是 `s` 到那个字段，新消息是
 * 一条 `p`，压缩头换掉前缀时是一条整段的 `p`（PIN-19 不约束形状）。纯 JSON，不依赖 Node / Electron。
 *
 * **按引用跳过（P4-09b）**：草稿是 chord 的代理，每读一个槽都要过陷阱 —— 逐帧走遍整份视图的代价随会话
 * 长度线性增长。调用方可以再给一个 `prev`：**上一次写进这份状态的那个 `next` 本身**，前提是草稿此刻与它
 * 深相等（投影是状态唯一的写者，且从不改动交出去过的对象；见 `ProjectorCore.revise`）。有了它：
 *
 *  - 一个槽上 `next` 与 `prev` 是同一个引用（或相等的原始值）→ 整个子树跳过，不读草稿、不发操作；
 *  - 身份、长度、键的判断都在 `prev`（普通对象）上做，只有真的变了的槽才碰草稿；
 *  - 发出的操作与不带 `prev` 时逐条相同（判断依据深相等，结论一样）。
 *
 * 投影一侧（`project.ts` 的 `ProjectionMemo`）让没变的消息、实时卡、工具运行沿用上一帧的对象，于是流式的
 * 一帧只走变了的那几个槽，而不是整份历史。
 */

type JsonRecord = { [key: string]: unknown }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数组元素的身份：`id`（消息 / 询问）或 `submissionId`（队列）；没有 → undefined */
function identityOf(value: unknown): string | number | undefined {
  if (!isRecord(value)) return undefined
  const id = value.id ?? value.submissionId
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

/** `prev` 只在与 `next` 同种容器时往下传（否则那个槽没有可比的上一份，走草稿） */
function sameKind(prev: unknown, next: unknown): unknown {
  if (Array.isArray(next)) return Array.isArray(prev) ? prev : undefined
  if (isRecord(next)) return isRecord(prev) ? prev : undefined
  return undefined
}

/**
 * 一个元素 / 字段：两边同种容器 → 递归；否则不同才赋值（返回要不要赋值）。
 * `prev`：草稿这个槽此刻深相等的那份上一次的值（没有 → undefined，读草稿判断）。
 */
function reconcileSlot(current: unknown, next: unknown, prev: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(next)) {
    reconcileArray(current, next, sameKind(prev, next) as readonly unknown[] | undefined)
    return false
  }
  if (isRecord(current) && isRecord(next)) {
    reconcileRecord(current, next, sameKind(prev, next) as JsonRecord | undefined)
    return false
  }
  return current !== next
}

function reconcileRecord(draft: JsonRecord, next: JsonRecord, prev?: JsonRecord): void {
  if (prev === undefined) {
    for (const key of Object.keys(draft)) {
      // 赋 undefined = 删除这个键（chord 草稿的约定）
      if (!Object.hasOwn(next, key)) draft[key] = undefined
    }
    for (const key of Object.keys(next)) {
      const value = next[key]
      if (!Object.hasOwn(draft, key) || reconcileSlot(draft[key], value, undefined)) {
        draft[key] = value
      }
    }
    return
  }
  // 草稿 ≡ prev：键与值都在 prev 上判断，只碰变了的槽。真有键要删时才枚举草稿 —— 按草稿的键序删，
  // 与不带 prev 时操作的次序也一样（状态里的键序可能与 prev 不同：chord 按插入次序保留键）
  let deletes = false
  for (const key of Object.keys(prev)) {
    if (!Object.hasOwn(next, key)) {
      deletes = true
      break
    }
  }
  if (deletes) {
    for (const key of Object.keys(draft)) {
      if (!Object.hasOwn(next, key)) draft[key] = undefined
    }
  }
  for (const key of Object.keys(next)) {
    const value = next[key]
    if (!Object.hasOwn(prev, key)) {
      draft[key] = value
      continue
    }
    const before = prev[key]
    if (value === before) continue // 同一个引用 / 相等的原始值：整个子树不变
    if (reconcileSlot(draft[key], value, before)) draft[key] = value
  }
}

function reconcileArray(
  draft: unknown[],
  next: readonly unknown[],
  prev?: readonly unknown[]
): void {
  // 判断都在「草稿此刻的值」上做：有 prev 就用它（普通数组，不过代理），否则读草稿
  const base: readonly unknown[] = prev ?? draft
  const shared = Math.min(base.length, next.length)
  let keyed = base.length > 0 && next.length > 0
  for (let index = 0; keyed && index < base.length; index++) {
    if (identityOf(base[index]) === undefined) keyed = false
  }
  for (let index = 0; keyed && index < next.length; index++) {
    if (identityOf(next[index]) === undefined) keyed = false
  }
  // 共同前缀：按身份对齐时到第一个身份不同的位置为止；按下标对齐时就是两者较短的长度
  let prefix = shared
  if (keyed) {
    prefix = 0
    while (prefix < shared && identityOf(base[prefix]) === identityOf(next[prefix])) prefix++
  }
  for (let index = 0; index < prefix; index++) {
    const value = next[index]
    if (prev !== undefined && value === prev[index]) continue
    if (reconcileSlot(draft[index], value, prev?.[index])) draft[index] = value
  }
  if (prefix === base.length) {
    if (next.length > prefix) draft.push(...next.slice(prefix))
    return
  }
  if (prefix === next.length) {
    draft.splice(prefix, base.length - prefix)
    return
  }
  draft.splice(prefix, base.length - prefix, ...next.slice(prefix))
}

/**
 * 把 `next` 逐字段写进 `draft`（chord 的草稿根：一个对象）。之后草稿的值与 `next` 深相等。
 * `next` 必须是严格 JSON（投影的输出就是）；`next` 里的对象会被 chord 按值拷贝，调用方之后改它不影响状态。
 *
 * `prev`（可选）：上一次写进这份状态的值，**草稿此刻必须与它深相等**，且它与 `next` 共享的对象从那以后
 * 没被改动过 —— 这时与它同一引用的子树整个跳过。不满足就不要给（给了错的 `prev` 状态会偏离 `next`）。
 */
export function reconcile(draft: object, next: object, prev?: object): void {
  reconcileRecord(draft as JsonRecord, next as JsonRecord, prev as JsonRecord | undefined)
}
