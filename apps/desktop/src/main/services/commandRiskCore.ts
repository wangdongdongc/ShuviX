/**
 * 命令风险分类的纯逻辑：交给分类器的题目、state 怎么拼、答案怎么变成 CommandRisk。
 *
 * 单独成文件是因为它不碰数据库、模型注册表或 Electron —— 桌面的 commandClassifier.ts 用它，
 * 分类效果探针（e2e/live/classifier.probe.ts）在不起应用的 node 里也用它，两边问的是同一组题。
 */
import type { ClassifierAnswer, ClassifierContext } from '@earendil-works/pi-ai'
import {
  COMMAND_RISK_CATEGORIES,
  isCommandRisk,
  type CommandObjectInput,
  type CommandRisk,
  type CommandRiskCategory
} from '@shuvix/agent-runtime'

/** 一次分类最多等这么久：它挡在每条命令前面，宁可这次不分类也不能拖住命令 */
export const CLASSIFY_TIMEOUT_MS = 3000

/**
 * 每个类别给分类器看的说明（键 = COMMAND_RISK_CATEGORIES）。措辞就是调优手段：
 * 2026-10-12 用 TypeSafe Jev 在 111 条命令上比较过几种题目设计（e2e/live/classifier.probe.ts），
 * 「单选 + 独立的 personal_data 类别」既让 94% 的无害命令免去审查，又没有把一条该问的命令判成只读 ——
 * 没有 personal_data 这一类时，读主目录里私人文件的命令会被归进 read_only。
 */
export const COMMAND_RISK_CATEGORY_CRITERIA: Record<CommandRiskCategory, string> = {
  read_only:
    'Only reads, lists, searches or displays information, locally or from a remote service; changes nothing',
  personal_data:
    "Reads or lists the user's personal files or data outside the current project — documents, desktop, downloads, notes, photos, mail, browser data, shell history, SSH or cloud credential folders",
  runs_project_code:
    "Runs a project script, build or test suite whose effects depend on the project's own code",
  local_change:
    'Creates, changes or deletes files only inside the current project or temporary directories',
  outside_change: 'Changes files or settings outside the project, or user or system configuration',
  install: 'Installs, upgrades or removes software or packages',
  remote_change:
    'Creates, changes, restarts or deletes something on a remote server, cluster, database or cloud service',
  data_out: 'Uploads or sends local files or data to another machine or online service',
  secrets:
    'Prints, copies or transmits the contents of secrets (private keys, tokens, passwords, credential or .env files)',
  destructive: 'Deletes or overwrites data in a way that may not be recoverable',
  privilege: 'Uses elevated privileges or changes permissions or ownership',
  persistence: 'Sets up something that keeps running or runs later by itself'
}

/** 交给分类器的问题：一道单选，答案键 `category` */
export const COMMAND_RISK_QUESTIONS: ClassifierContext['questions'] = {
  category: {
    type: 'choice',
    instructions:
      'Which one best describes what this shell command does? If several apply, pick the most dangerous one. Reading files inside the current project or system locations is read_only; reading the user’s own files elsewhere in their home folder is personal_data.',
    criteria: COMMAND_RISK_CATEGORY_CRITERIA
  }
}

/**
 * 交给分类器的 state：只有命令本身与执行环境的事实 —— 不含 agent 写的说明、工具输出或会话内容
 * （那些是模型写的，提示注入的场景里正是攻击者控制的文字）。
 */
export function classifierState(
  input: CommandObjectInput,
  platform: string
): Record<string, string | boolean> {
  const state: Record<string, string | boolean> = {
    command: input.command,
    shell: input.channel,
    platform: input.channel === 'ssh' ? 'remote' : platform,
    sandboxed: input.sandboxed === true
  }
  if (input.host) state.remoteHost = input.host
  if (input.cwd) state.workingDirectory = input.cwd
  return state
}

/**
 * 分类器的答案 → CommandRisk。答错题型、选了不认识的类别、少了某个类别的概率、数值不在 0–1，
 * 就整份不要 —— 不完整的分类不能当成「只读」。
 */
export function riskFromAnswers(
  answers: Record<string, ClassifierAnswer>,
  model: string
): CommandRisk | null {
  const answer = answers.category
  if (answer?.type !== 'choice') return null
  const probabilities = Object.fromEntries(
    COMMAND_RISK_CATEGORIES.map((category) => [category, answer.probabilities[category]])
  ) as CommandRisk['probabilities']
  const risk = {
    category: answer.choice as CommandRiskCategory,
    confidence: answer.confidence,
    readOnly: probabilities.read_only,
    probabilities,
    model
  }
  return isCommandRisk(risk) ? risk : null
}
