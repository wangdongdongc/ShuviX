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

/** 一个元素 / 字段：两边同种容器 → 递归；否则不同才赋值（返回要不要赋值） */
function reconcileSlot(current: unknown, next: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(next)) {
    reconcileArray(current, next)
    return false
  }
  if (isRecord(current) && isRecord(next)) {
    reconcileRecord(current, next)
    return false
  }
  return current !== next
}

function reconcileRecord(draft: JsonRecord, next: JsonRecord): void {
  for (const key of Object.keys(draft)) {
    // 赋 undefined = 删除这个键（chord 草稿的约定）
    if (!Object.hasOwn(next, key)) draft[key] = undefined
  }
  for (const key of Object.keys(next)) {
    const value = next[key]
    if (!Object.hasOwn(draft, key) || reconcileSlot(draft[key], value)) draft[key] = value
  }
}

function reconcileArray(draft: unknown[], next: readonly unknown[]): void {
  const shared = Math.min(draft.length, next.length)
  let keyed = draft.length > 0 && next.length > 0
  for (let index = 0; keyed && index < draft.length; index++) {
    if (identityOf(draft[index]) === undefined) keyed = false
  }
  for (let index = 0; keyed && index < next.length; index++) {
    if (identityOf(next[index]) === undefined) keyed = false
  }
  // 共同前缀：按身份对齐时到第一个身份不同的位置为止；按下标对齐时就是两者较短的长度
  let prefix = shared
  if (keyed) {
    prefix = 0
    while (prefix < shared && identityOf(draft[prefix]) === identityOf(next[prefix])) prefix++
  }
  for (let index = 0; index < prefix; index++) {
    if (reconcileSlot(draft[index], next[index])) draft[index] = next[index]
  }
  if (prefix === draft.length) {
    if (next.length > prefix) draft.push(...next.slice(prefix))
    return
  }
  if (prefix === next.length) {
    draft.splice(prefix, draft.length - prefix)
    return
  }
  draft.splice(prefix, draft.length - prefix, ...next.slice(prefix))
}

/**
 * 把 `next` 逐字段写进 `draft`（chord 的草稿根：一个对象）。之后草稿的值与 `next` 深相等。
 * `next` 必须是严格 JSON（投影的输出就是）；`next` 里的对象会被 chord 按值拷贝，调用方之后改它不影响状态。
 */
export function reconcile(draft: object, next: object): void {
  reconcileRecord(draft as JsonRecord, next as JsonRecord)
}
