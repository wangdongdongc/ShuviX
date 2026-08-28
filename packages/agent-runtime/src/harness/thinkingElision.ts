/**
 * 历史 thinking 剥离 —— 把已完成轮次的推理块从请求里摘掉，只留最近的一段。
 *
 * 为什么要做：thinking 块会被**全额计费**、也**全额占窗口**，上游不会替你剥。
 *
 * 真实规模实测（Kimi Coding，一条 711 条消息的真实会话载荷）：
 *   原始   8.4MB  257,714 tok
 *   剥离后 7.3MB  214,807 tok   —— 剥掉 212 个块，省 42,907 tok（16.6%）
 * 剥离后的载荷被服务端正常接受，无协议错误 —— 保护线的契约处理在真实规模上成立。
 *
 * 16.6% 是这件事的**真实量级**，别拿更大的数字给它辩护：曾按「整个 thinking 块的
 * JSON 长度 / 4」估算过，得出 68.9%，那是错的 —— 块里的 signature 是一长串 base64，
 * 按字符估会严重虚高。下面 estimate() 只数 thinking 正文，与实测吻合（估 38.5k /
 * 实测 42.9k）。
 *
 * **收益主要是窗口，不是钱。** 边界每跳一次，前缀从剥离点起全部改变，那一个请求要
 * 重新写满缓存（~215k × 1.25）；之后每个请求少读 ~43k（× 0.1）。要几十个请求才摊平。
 * 所以阈值要调得**跳得少、每次剥得多**，把它当作「延后压缩、保住工作状态」的手段，
 * 而不是省钱手段。真想省钱，缓存本身已经把历史的成本吃掉了（实测 p50 仅 333
 * uncached tok）。
 *
 * 为什么必须「稳定边界」而不是「只留当前轮」：缓存是按前缀命中的。若每轮都把
 * 上一轮的 thinking 剥掉，前缀逐轮变化，缓存永不命中。实测四种策略（同一会话，
 * uncached input / cache read）：
 *
 *   现状（历史不动）            277 / 2752
 *   天真剥法（每轮都剥）        649 /   64   ← 缓存被打穿
 *   稳定边界（边界不动）        237 /  704   ← 最优：命中恢复，且总量最低
 *   边界每轮移动                335 /  448
 *
 * 所以边界只在累计 thinking 越过上沿时**跳一次**，平时钉死不动 —— 两次跳跃之间
 * 输出逐字节稳定，缓存行为与不做这件事时完全一致。滞回（trigger/keep 两个阈值）
 * 是为了让跳跃稀疏：剥到下沿之后要重新长到上沿才会再跳一次。
 *
 * 自适应性来自阈值本身：thinking 短的模型（实测 kimi-k3 每块均值 26 tok）永远
 * 达不到上沿，边界不推进，这个模块等于不存在，也就不会为了省几十 token 去打穿缓存。
 */

/** 一个 thinking 块（Anthropic wire 形状；signature 会被服务端校验，只可整块丢弃，不可修改） */
interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking'
  thinking?: string
  signature?: string
}

export interface ContentBlock {
  type?: string
  [k: string]: unknown
}

export interface WireMessage {
  role?: string
  content?: ContentBlock[] | string
  [k: string]: unknown
}

export interface ThinkingElisionOptions {
  /** 可剥区间内累计 thinking 超过它，边界才前移（滞回上沿） */
  triggerTokens: number
  /** 前移后保留多少最近的 thinking（滞回下沿），必须 < triggerTokens */
  keepTokens: number
}

/**
 * 默认阈值：**跳得少、每次剥得多**。
 *
 * 每次跳跃都要重写一遍缓存，代价固定且不小；能摊平它的只有「这次剥掉了多少」。
 * 40k/4k 意味着每跳一次回收 ~36k 窗口，而按实测每块 ~180 tok、每轮约 2 块算，
 * 大约每 110 轮才跳一次 —— 一个长会话里也就跳几次。
 *
 * 别为了「早点省一点」把上沿调低：那只会让跳跃变密，把缓存反复打穿。
 */
export const DEFAULT_THINKING_ELISION: ThinkingElisionOptions = {
  triggerTokens: 40_000,
  keepTokens: 4_000
}

/** 边界：索引 < boundary 的消息其 thinking 已被剥离。跨调用持有，只在跳跃时变化。 */
export interface ThinkingElisionState {
  boundary: number
}

export interface ThinkingElisionResult {
  messages: WireMessage[]
  /** 新边界（调用方需写回 state） */
  boundary: number
  elidedBlocks: number
  elidedTokens: number
  /** 边界是否发生了跳跃 —— 只有 true 时这一轮才会有缓存失配 */
  advanced: boolean
}

/** 粗估 token：字符数 / 4。这里只用于和阈值比大小，不需要精确 */
function estimate(text: string | undefined): number {
  return text ? Math.ceil(text.length / 4) : 0
}

function isThinking(b: ContentBlock): b is ThinkingBlock & ContentBlock {
  return b.type === 'thinking' || b.type === 'redacted_thinking'
}

function blocksOf(m: WireMessage): ContentBlock[] {
  return Array.isArray(m.content) ? m.content : []
}

/**
 * 保护线 —— 该索引及其之后的 thinking 一律不动。取**最后一条 assistant 消息**的位置。
 *
 * Anthropic 契约要求的其实很窄：在 tool_result 之后要模型继续时，必须原样带回
 * **正在被延续的那条** assistant 消息的 thinking，否则推理链断。更早的轮次不在此列。
 *
 * 曾经把保护线定成「最后一条用户真正说话的消息」，那是错的：长 agent 循环里用户
 * 只在开头说一次，后面几百条全是 tool_result，保护线会一路停在 0，模块等于永不生效 ——
 * 而那恰恰是最需要它的形状（实测一条真实载荷 711 条消息、只有 1 条真正的用户消息）。
 *
 * 更近的推理靠 keepTokens 那个窗口保留，不靠这条线；这条线只负责契约正确性。
 * 找不到 assistant 消息就返回 0（= 全程保护）：宁可不省，也不能把活的推理链剪断。
 */
export function protectedFrom(messages: WireMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i
  }
  return 0
}

/**
 * 按稳定边界剥离历史 thinking。
 *
 * 未越过上沿时原样返回**同一个数组同一批对象**，调用方据此可判定「什么都没做」；
 * 越过时只克隆被改动的那几条消息，其余仍是原对象 —— 保证未改动区间逐字节稳定。
 *
 * 与自动压缩的关系：压缩会重写整个消息列表，旧边界索引随之失效。这里每次都把边界
 * 夹到 [0, protectedFrom] 内，压缩后最多是「剥得比需要的多」（无害，省得更多），
 * 绝不会越界或误伤正在延续的那条 —— 边界不需要跟压缩做任何协调。
 */
export function elideHistoricalThinking(
  messages: WireMessage[],
  state: ThinkingElisionState,
  opts: ThinkingElisionOptions = DEFAULT_THINKING_ELISION
): ThinkingElisionResult {
  const protect = protectedFrom(messages)
  // 压缩重写过列表时旧边界可能越界；夹回来即可，不需要与压缩协调
  const boundary = Math.max(0, Math.min(state.boundary, protect))

  // 可剥区间 = [boundary, protect)：已剥的不用再看，正在延续的那条不能碰
  let pending = 0
  for (let i = boundary; i < protect; i++) {
    for (const b of blocksOf(messages[i])) if (isThinking(b)) pending += estimate(b.thinking)
  }

  // 没到上沿：一个字节都不动，缓存前缀与上一轮完全相同
  if (pending <= opts.triggerTokens) {
    return { messages, boundary, elidedBlocks: 0, elidedTokens: 0, advanced: false }
  }

  // 到了上沿：把边界往前推到「剩余 thinking ≤ 下沿」为止
  let remaining = pending
  let next = boundary
  while (next < protect && remaining > opts.keepTokens) {
    for (const b of blocksOf(messages[next])) if (isThinking(b)) remaining -= estimate(b.thinking)
    next++
  }

  let elidedBlocks = 0
  let elidedTokens = 0
  const out = messages.slice()
  for (let i = 0; i < next; i++) {
    const blocks = blocksOf(messages[i])
    if (!blocks.some(isThinking)) continue
    const kept = blocks.filter((b) => !isThinking(b))
    // 剥完会变成空消息的（只有 thinking、没有 text/tool_use）就整条留着 ——
    // 空 content 数组会被服务端拒掉，省这一点不值得赌
    if (kept.length === 0) continue
    for (const b of blocks) {
      if (isThinking(b)) {
        elidedBlocks++
        elidedTokens += estimate(b.thinking)
      }
    }
    out[i] = { ...messages[i], content: kept }
  }

  return { messages: out, boundary: next, elidedBlocks, elidedTokens, advanced: next !== boundary }
}
