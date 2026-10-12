/**
 * 分类器调用：统一入口 + 审计日志（classifier_logs 表，迁移 v32）。
 *
 * 任何一个「拿分类模型判断某件事」的场景都经 `classifyAndLog` 调用：它负责超时、取消，并把每次调用
 * —— 场景、被分类对象的摘要、题目与发送内容、答案、耗时、状态 —— 记一行，设置里「监控 → 分类器」
 * 一页按题型通用地展示。今天只有命令风险分类（scene `command-risk`，见 commandClassifier.ts）；
 * 以后多一个场景不用加表、加列或加页面，只要换一个 scene 名调这里。
 *
 * 日志条数有上限（只留最新的 MAX_ROWS 条）。内存会话不记：它的东西不落盘（与 LLM 请求日志同一条规矩）。
 * 写日志失败只记一条告警，绝不影响分类本身。
 */
import { v7 as uuidv7 } from 'uuid'
import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
  Models
} from '@earendil-works/pi-ai'
import { classifierLogDao } from '../dao/classifierLogDao'
import { sessionRecords } from './sessionRecords'
import { createLogger } from '../logger'
import type {
  ClassifierLog,
  ClassifierLogListParams,
  ClassifierLogStatus,
  ClassifierLogSummary
} from '../types'

const log = createLogger('ClassifierLog')

/** 日志最多留这么多条（每次调用一行、每行一两 KB，五千条也就几 MB） */
export const MAX_ROWS = 5000
/** 每写这么多条修剪一次（不必每次都删） */
const PRUNE_EVERY = 100
/** 对象摘要的长度上限（一条长脚本不该把列表撑爆；完整内容在 request 里） */
const SUBJECT_MAX = 500

/** 写一行日志所需的字段（id / 时间由服务补） */
export interface ClassifierLogInput {
  scene: string
  sessionId?: string
  toolCallId?: string
  subject: string
  provider: string
  model: string
  context: ClassifierContext
  answers?: ClassifierResult['answers']
  status: ClassifierLogStatus
  error?: string
  ms: number
  inputTokens?: number
  cost?: number
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

export class ClassifierLogService {
  private sinceLastPrune = 0

  /** 记一行；内存会话不记；失败只告警 */
  record(input: ClassifierLogInput): void {
    // 删掉之后迟到的那一条也不记（与通知、日历入账同一条规矩）
    if (
      input.sessionId &&
      (sessionRecords.isEphemeral(input.sessionId) || sessionRecords.wasEphemeral(input.sessionId))
    ) {
      return
    }
    const row: ClassifierLog = {
      id: uuidv7(),
      createdAt: Date.now(),
      scene: input.scene,
      sessionId: input.sessionId ?? '',
      toolCallId: input.toolCallId ?? '',
      subject: input.subject.slice(0, SUBJECT_MAX),
      provider: input.provider,
      model: input.model,
      request: stringify(input.context),
      response: input.answers ? stringify(input.answers) : '',
      status: input.status,
      error: input.error ?? '',
      ms: input.ms,
      inputTokens: input.inputTokens ?? 0,
      cost: input.cost ?? 0
    }
    try {
      classifierLogDao.insert(row)
      if (++this.sinceLastPrune >= PRUNE_EVERY) {
        this.sinceLastPrune = 0
        classifierLogDao.prune(MAX_ROWS)
      }
    } catch (err) {
      log.warn(`写分类器日志失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  list(params?: ClassifierLogListParams): ClassifierLogSummary[] {
    return classifierLogDao.list(params)
  }

  getById(id: string): ClassifierLog | undefined {
    return classifierLogDao.getById(id)
  }

  scenes(): string[] {
    return classifierLogDao.scenes()
  }

  clear(): void {
    classifierLogDao.clear()
  }
}

export const classifierLogService = new ClassifierLogService()

/** classifyAndLog 的结果：答案（没拿到 = null）与这次调用的状态 */
export interface ClassifyOutcome {
  result: ClassifierResult | null
  status: ClassifierLogStatus
  ms: number
  error?: string
}

/**
 * 调一次分类模型并记日志 —— 所有分类场景的统一入口。
 *
 * - 超时（`timeoutMs`）与调用方的 signal 合在一起交给 pi；调用方取消记 `aborted`，到时没回记 `timeout`。
 * - pi 回 `stopReason !== 'stop'` 或抛错记 `failed`。
 * - 拿到答案后交给 `accept` 判断这份答案对这个场景是否可用，不可用记 `incomplete`（结果仍交回，
 *   由场景自己丢弃）。
 * - `record` 默认写 classifier_logs；测试换成自己的。
 */
export async function classifyAndLog(params: {
  models: Pick<Models, 'classify'>
  model: ClassifierModel<ClassifierApi>
  providerId: string
  modelId: string
  context: ClassifierContext
  scene: string
  subject: string
  sessionId?: string
  toolCallId?: string
  signal?: AbortSignal
  timeoutMs: number
  accept?: (result: ClassifierResult) => boolean
  record?: (input: ClassifierLogInput) => void
}): Promise<ClassifyOutcome> {
  const writeLog = params.record ?? ((input) => classifierLogService.record(input))
  // 记日志出错绝不能改变分类结果，也不能在 catch 里再记一遍
  const record = (input: ClassifierLogInput): void => {
    try {
      writeLog(input)
    } catch (err) {
      log.warn(`写分类器日志失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const timeout = AbortSignal.timeout(params.timeoutMs)
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout
  const base = {
    scene: params.scene,
    sessionId: params.sessionId,
    toolCallId: params.toolCallId,
    subject: params.subject,
    provider: params.providerId,
    model: params.modelId,
    context: params.context
  }
  const started = Date.now()
  /** 中止的原因：调用方取消，还是超时 */
  const abortStatus = (): ClassifierLogStatus | null =>
    params.signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : null

  try {
    const result = await params.models.classify(params.model, params.context, { signal })
    const ms = Date.now() - started
    const usage = {
      inputTokens: result.usage?.input ?? 0,
      cost: result.usage?.cost.total ?? 0
    }
    if (result.stopReason !== 'stop') {
      const status = abortStatus() ?? 'failed'
      const error = result.errorMessage
        ? `${result.stopReason}: ${result.errorMessage}`
        : result.stopReason
      record({ ...base, ...usage, status, error, ms })
      return { result: null, status, ms, error }
    }
    if (params.accept && !params.accept(result)) {
      const error = 'answers are incomplete or out of range'
      record({ ...base, ...usage, answers: result.answers, status: 'incomplete', error, ms })
      return { result, status: 'incomplete', ms, error }
    }
    record({ ...base, ...usage, answers: result.answers, status: 'ok', ms })
    return { result, status: 'ok', ms }
  } catch (err) {
    const ms = Date.now() - started
    const status = abortStatus() ?? 'failed'
    const error = err instanceof Error ? err.message : String(err)
    record({ ...base, status, error, ms })
    return { result: null, status, ms, error }
  }
}
