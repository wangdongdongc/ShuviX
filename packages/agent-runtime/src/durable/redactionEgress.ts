/**
 * 自动脱敏的策略判定（docs/auto-redaction-design.md §16）：**策略只决定新写进对话记录的内容脱不脱敏**，发给模型时
 * 记录里存什么就发什么，出口不改写、不回头。这里只剩判定的形状，以及第一层拒发时不发请求的错误。
 *
 * 策略的判定由调用方交进来（EgressDecision）：宿主用安全模块按第一层（modelRequest / send / detect）与第二层
 * （sensitive / disclose / redact）判。
 */

/** 第二层的处置：写入时 redact 与 block 都存占位符，send 存原文 */
export type DiscloseAction = 'redact' | 'send' | 'block'

/** 对某个模型的策略判定 */
export interface EgressDecision {
  /** 第一层判为拒发（用户自己写的 deny，比如「这个 bot 只许用家里的服务器」）：整个请求不发 */
  blocked?: boolean
  /** 第一层：发给这个模型的新内容适用脱敏（处置 detect）；不适用 = 不检测、不换，原样写进记录 */
  applies: boolean
  /** 第二层：一处敏感内容怎么处理 */
  disclose(item: { category: string; rule: string; value: string }): DiscloseAction
}

/** 第一层拒发：整个请求不发 */
export class EgressBlockedError extends Error {
  constructor() {
    super(
      'A security policy does not allow sending requests to this model; the request was not sent.'
    )
    this.name = 'EgressBlockedError'
  }
}
