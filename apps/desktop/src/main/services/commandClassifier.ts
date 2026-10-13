/**
 * 命令风险分类（安全模块 `classifyCommand` 接缝的桌面实现）。
 *
 * 设置里选了分类模型（通用设置「分类模型」，`general.classifierProvider` / `general.classifierModel`），
 * 每条要执行的命令（bash / powershell / ssh exec，沙箱内外都算）在策略求值之前过一次分类，结果作为
 * 命令客体的 `risk` 交给安全策略（字段见 agent-runtime 的 CommandRisk）。没选模型 / 模型不见了 / 请求
 * 失败 / 超时，就交回 null —— 客体上没有 risk，引用它的规则按严格语义 fail-safe（只会多问）。
 *
 * 每次分类都经 classifierLogService 的 `classifyAndLog` 记一行分类器日志（场景 `command-risk`：命令、
 * 题目与发送内容、答案、耗时、状态），设置「监控 → 分类器」里看得到。配置有问题的那几种也记，
 * 主日志只按原因各告警一次。
 *
 * 分类器是 pi-ai 的「分类」类模型（`models.classify`：结构化 state + 一组封闭问题 → 带概率的答案，
 * 例如 TypeSafe 的 Jev：内置提供商 TypeSafe 直连，或经 OpenRouter / OpenCode / Cloudflare）。给它的只有命令
 * 本身与执行环境的事实，不含 agent 写的说明、工具输出或会话内容。
 */
import type { Models } from '@earendil-works/pi-ai'
import type { AvailableModel } from '@shuvix/chat-protocol/types/provider'
import {
  piProviderIdOf,
  type CommandObjectInput,
  type CommandRisk,
  type ProviderCredentialPort
} from '@shuvix/agent-runtime'
import { getModelRegistry, providerCredentialPort } from './models'
import { settingsDao } from '../dao/settingsDao'
import { createLogger } from '../logger'
import {
  classifierLogService,
  classifyAndLog,
  type ClassifierLogInput
} from './classifierLogService'
import {
  CLASSIFY_TIMEOUT_MS,
  COMMAND_RISK_QUESTIONS,
  classifierState,
  riskFromAnswers
} from './commandRiskCore'

// 纯逻辑（题目、答案映射、state）在 commandRiskCore —— 探针在不起应用的 node 里也要用它们
export { CLASSIFY_TIMEOUT_MS, COMMAND_RISK_QUESTIONS, classifierState, riskFromAnswers }

const log = createLogger('CommandClassifier')

/** 分类器日志里这个场景的名字 */
export const COMMAND_RISK_SCENE = 'command-risk'

/** 分类模型的设置键（provider 行 id + 模型 id），放在默认模型旁边 */
export const CLASSIFIER_PROVIDER_KEY = 'general.classifierProvider'
export const CLASSIFIER_MODEL_KEY = 'general.classifierModel'

/** 服务用到的外部设施 —— 默认接主进程的单例，测试换成假的 */
export interface CommandClassifierDeps {
  /** 读一个设置值（空串 / 缺失 = 没设） */
  readSetting: (key: string) => string | undefined
  /** 模型集合（桌面：模型注册表那份） */
  models: () => Pick<Models, 'getModelOfType' | 'getModelsOfType' | 'classify'>
  /** provider 表（把设置里的行 id 换成 pi 的 provider id） */
  port: () => Pick<ProviderCredentialPort, 'listProviders'>
  /** 平台（交给分类器的环境事实） */
  platform: string
  /** 记一行分类器日志 */
  record: (input: ClassifierLogInput) => void
}

const defaultDeps: CommandClassifierDeps = {
  readSetting: (key) => settingsDao.findByKey(key),
  models: () => getModelRegistry().models,
  port: () => providerCredentialPort,
  platform: process.platform,
  record: (input) => classifierLogService.record(input)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface CommandClassifier {
  /**
   * 分类一条命令；没配置 / 失败 / 超时 → null。每次调用（含配置有问题的那种）记一行分类器日志，
   * sessionId / toolCallId 用来在日志里对上是哪个会话的哪次调用。
   */
  classify(
    input: CommandObjectInput,
    opts?: { signal?: AbortSignal; toolCallId?: string; sessionId?: string }
  ): Promise<CommandRisk | null>
  /**
   * 可选的分类模型：已启用提供商目录里的「分类」类模型，形状同对话模型选择器的 AvailableModel
   * （providerId 是 provider 行 id，与默认模型的设置同一种写法）。
   */
  listModels(): AvailableModel[]
}

export function createCommandClassifier(
  deps: CommandClassifierDeps = defaultDeps
): CommandClassifier {
  /** 同一个配置问题只告警一次（每条命令都会走到这里） */
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    log.warn(message)
  }

  return {
    listModels() {
      const models = deps.models()
      return deps
        .port()
        .listProviders()
        .filter((row) => row.isEnabled)
        .flatMap((row) => {
          const providerId = piProviderIdOf(row)
          if (!providerId) return []
          let found: ReturnType<typeof models.getModelsOfType<'classifier'>> = []
          try {
            found = models.getModelsOfType('classifier', providerId)
          } catch (err) {
            log.warn(`列出 ${row.name} 的分类模型失败：${errorText(err)}`)
          }
          return found.map(
            (model, index): AvailableModel => ({
              id: `${row.id}:${model.id}`,
              providerId: row.id,
              modelId: model.id,
              isEnabled: 1,
              sortOrder: index,
              capabilities: '{}',
              providerName: row.displayName || row.name
            })
          )
        })
    },

    async classify(input, opts = {}) {
      const providerRowId = deps.readSetting(CLASSIFIER_PROVIDER_KEY)?.trim()
      const modelId = deps.readSetting(CLASSIFIER_MODEL_KEY)?.trim()
      if (!providerRowId || !modelId) return null

      const context = {
        state: classifierState(input, deps.platform),
        questions: COMMAND_RISK_QUESTIONS
      }
      const logBase = {
        scene: COMMAND_RISK_SCENE,
        sessionId: opts.sessionId,
        toolCallId: opts.toolCallId,
        subject: (input.host ? `[ssh ${input.host}] ` : '') + input.command,
        context
      }
      /**
       * 配置有问题：记一行日志（界面上看得到为什么没分类），主日志同一个问题只告警一次。
       * 文本用英文：它原样显示在分类器日志页里，不跟界面语言走
       */
      const misconfigured = (key: string, error: string, provider = '', model = modelId): null => {
        warnOnce(key, error)
        deps.record({ ...logBase, provider, model, status: 'misconfigured', error, ms: 0 })
        return null
      }

      const row = deps
        .port()
        .listProviders()
        .find((candidate) => candidate.id === providerRowId)
      if (!row) {
        return misconfigured(
          `row:${providerRowId}`,
          `Classifier provider ${providerRowId} no longer exists`,
          providerRowId
        )
      }
      // 提供商停用了就不再用它（设置里的下拉也只列已启用的提供商）
      if (!row.isEnabled) {
        return misconfigured(
          `disabled:${providerRowId}`,
          `Classifier provider ${row.name} is disabled`,
          row.name
        )
      }
      const providerId = piProviderIdOf(row)
      if (!providerId) {
        return misconfigured(
          `noslug:${providerRowId}`,
          `Classifier provider ${row.name || providerRowId} has no provider id`,
          row.name
        )
      }
      const models = deps.models()
      const model = models.getModelOfType('classifier', providerId, modelId)
      if (!model) {
        return misconfigured(
          `model:${providerId}/${modelId}`,
          `Classifier model ${providerId}/${modelId} is not in the model catalog`,
          providerId
        )
      }

      const modelName = `${providerId}/${modelId}`
      let risk: CommandRisk | null = null
      const outcome = await classifyAndLog({
        models,
        model,
        providerId,
        modelId,
        context,
        scene: logBase.scene,
        subject: logBase.subject,
        sessionId: opts.sessionId,
        toolCallId: opts.toolCallId,
        signal: opts.signal,
        timeoutMs: CLASSIFY_TIMEOUT_MS,
        accept: (result) => (risk = riskFromAnswers(result.answers, modelName)) !== null,
        record: deps.record
      })
      if (outcome.status === 'ok') {
        log.debug(`命令分类 ${outcome.ms}ms ${risk!.category} ${risk!.confidence.toFixed(2)}`)
        return risk
      }
      // 用户按了停止：不是分类器的问题，不告警。其余原因按原因告警一次（每条命令都会走到这里，
      // 一个没配 key 的分类器不该把主日志刷满；每一次的细节在分类器日志里）
      if (outcome.status !== 'aborted') {
        warnOnce(
          `fail:${outcome.status}:${outcome.error ?? ''}`,
          `命令分类没有完成（${outcome.status}）：${outcome.error ?? ''}`.trim()
        )
      }
      return null
    }
  }
}

export const commandClassifier = createCommandClassifier()
