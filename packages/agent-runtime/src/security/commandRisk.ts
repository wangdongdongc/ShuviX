/**
 * 命令风险分类（CommandRisk，见 types.ts）的形状校验 —— 宿主交来的分类要完整才挂上客体、才进决策记录。
 */
import { COMMAND_RISK_CATEGORIES, type CommandRisk, type SecurityObject } from './types'

const isProbability = (p: unknown): p is number =>
  typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1

/**
 * 是不是完整的一份分类：类别是已知的一类、把握与 readOnly 在 0–1、每个类别都有 0–1 的概率、带非空
 * 模型名（多余的键不管，挂上去时会丢掉）
 */
export function isCommandRisk(value: unknown): value is CommandRisk {
  if (!value || typeof value !== 'object') return false
  const risk = value as Record<string, unknown>
  if (!(COMMAND_RISK_CATEGORIES as readonly unknown[]).includes(risk.category)) return false
  if (!isProbability(risk.confidence) || !isProbability(risk.readOnly)) return false
  if (typeof risk.model !== 'string' || risk.model === '') return false
  const probabilities = risk.probabilities
  if (!probabilities || typeof probabilities !== 'object') return false
  return COMMAND_RISK_CATEGORIES.every((category) =>
    isProbability((probabilities as Record<string, unknown>)[category])
  )
}

/**
 * 只留 CommandRisk 的已知字段的一份拷贝 —— 宿主交来的对象可能带别的键，挂到客体上它们会进 CEL
 * 与决策日志；也不能和宿主共用同一个对象（宿主事后改它，已经判过的记录不该跟着变）。
 */
export function pickCommandRisk(risk: CommandRisk): CommandRisk {
  return {
    category: risk.category,
    confidence: risk.confidence,
    readOnly: risk.readOnly,
    probabilities: Object.fromEntries(
      COMMAND_RISK_CATEGORIES.map((category) => [category, risk.probabilities[category]])
    ) as CommandRisk['probabilities'],
    model: risk.model
  }
}

/** 命令客体上挂着的分类（没分 / 不是命令 → undefined） */
export function commandRiskOf(object: SecurityObject): CommandRisk | undefined {
  return object.type === 'command' && isCommandRisk(object.risk) ? object.risk : undefined
}
