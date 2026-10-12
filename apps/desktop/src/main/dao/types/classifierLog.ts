/**
 * 分类器调用日志一行（classifier_logs 表，迁移 v32）—— 每次调用分类模型一行，与分类场景无关。
 * request / response 是 JSON 文本：pi 的 ClassifierContext（state + questions）与答案。
 */
export interface ClassifierLog {
  id: string
  createdAt: number
  /** 分类场景（今天只有 'command-risk'） */
  scene: string
  /** 所属会话（没有 = ''） */
  sessionId: string
  /** 对应的工具调用（没有 = ''） */
  toolCallId: string
  /** 被分类的对象的一句摘要（命令风险分类里是命令本身），列表里显示它 */
  subject: string
  /** pi provider id / 模型 id */
  provider: string
  model: string
  /** 发给分类器的内容：`{ state, questions }` 的 JSON */
  request: string
  /** 分类器的答案（`ClassifierResult.answers`）的 JSON；没有答案 = '' */
  response: string
  /** ok | incomplete | failed | timeout | aborted | misconfigured */
  status: string
  error: string
  ms: number
  inputTokens: number
  /** 按目录价算的费用（美元），服务没报用量时为 0 */
  cost: number
}
