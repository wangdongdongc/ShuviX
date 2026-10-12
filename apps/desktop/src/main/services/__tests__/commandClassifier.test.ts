/**
 * commandClassifier —— 安全模块 `classifyCommand` 接缝的桌面实现：设置里选了分类模型
 * （`general.classifierProvider` / `general.classifierModel`），每条命令在策略求值前过一次 pi 的
 * `models.classify`（一道单选：这条命令属于 12 类中的哪一类），答案换成 agent-runtime 的 CommandRisk；
 * 没选 / 不见了 / 停用 / 失败 / 超时 / 被取消 → null（客体上没有 risk）。每次调用（配置有问题的也算）
 * 记一行分类器日志（场景 `command-risk`）；主日志按原因只告警一次。`listModels` 是设置页「分类模型」下拉的清单。
 *
 * 常量与答案换算：
 *   CC-0  一道单选 `category`：准则的键就是 COMMAND_RISK_CATEGORIES（同顺序）、文字非空、说明点到 read_only
 *         与 personal_data；超时 3000ms；两个设置键；场景名 command-risk
 *   CC-0b 漂移守护：每个类别都给概率的答案 → riskFromAnswers → 过得了 isCommandRisk
 *   RA-1..9 riskFromAnswers：完整的形状 / 多余概率丢掉 / 题型不对 / 缺答案 / 不认识的类别 / 缺某类概率 /
 *         概率越界 / 把握越界与空模型名 / 只校验形状（不必是最大概率）且不共用答案里的对象
 *
 * classify（A 组：假 models + 假 port + record spy）：
 *   CL-1  没设 → null、不请求、不记、不告警
 *   CL-2  行不存在 → misconfigured 日志（每次都记）、按 id 告警一次     CL-14 停用 → misconfigured、告警一次
 *   CL-3  模型不在目录 → misconfigured（provider = pi slug）            CL-4  内置 / 自定义行怎么找模型；没名字的内置行 → misconfigured
 *   CL-5  交给分类器的 state 逐键（日志里的 context 同一份）             CL-6  问题就是 COMMAND_RISK_QUESTIONS 本身
 *   CL-7  signal：超时 3000ms，与调用方的合一                            CL-8  超时 → timeout 日志，告警只一次
 *   CL-9  stopReason error / aborted → failed 日志 "<stopReason>: <msg>"，同一原因告警一次、换原因再告警
 *   CL-10 classify 抛错 → failed + 一条告警                             CL-11 答案不完整 → incomplete 日志（带答案）、不记成功
 *   CL-12 成功：恰为换算出的 risk、ok 日志（用量、耗时）、一条不带行 uuid 的 debug    CL-13 每次现读设置、现取 models / port
 *   CL-16 调用方取消 → aborted 日志、不告警，之后别的失败照样告警         CL-17 日志的对象摘要（ssh 带主机，长命令不截）
 *   CL-18 不给 opts：照常分类，日志里没有 sessionId / toolCallId
 *
 * listModels（A 组）：LM-1..6 只列已启用的行、条目形状、顺序、某行抛错跳过、无名内置行跳过、按 pi id 查。
 *
 * B 组（真 createModelRegistry + 假 fetch，`fakeAuthContext()` 不读 process.env —— 不发真请求）：
 *   RR-1..8 清单只来自 classifier 类模型 / 一次 System One 请求的线上形状与 ok 日志 / 缺答案、缺概率与 401 /
 *   没 key / 配置的是对话模型 / fetch 挂住时超时；CL-15 没 key → 每条命令一行 failed 日志、只告警一次。
 *
 * logger、settingsDao、../models、分类器日志 DAO 与会话记录全部 mock：模块 import 时就建了默认实例与模块级 log。
 * `AbortSignal.timeout` 不跟 vi 的假定时器走，改为 spy 它、交回可以手动触发的 signal。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ClassifierAnswer, ClassifierResult } from '@earendil-works/pi-ai'
import {
  COMMAND_RISK_CATEGORIES,
  createModelRegistry,
  isCommandRisk,
  type CommandObjectInput,
  type ProviderRow
} from '@shuvix/agent-runtime'
import {
  builtinRow,
  customRow,
  fakeAuthContext,
  fakePort
} from '../../../../../../packages/agent-runtime/src/models/__tests__/fakePort'
import type { ClassifierLogInput } from '../classifierLogService'

const cc = vi.hoisted(() => ({
  warn: vi.fn<(msg: string) => void>(),
  info: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string) => void>(),
  insert: vi.fn()
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: cc.info, warn: cc.warn, error: vi.fn(), debug: cc.debug })
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: () => undefined } }))
// 默认实例的依赖：本文件只用 createCommandClassifier(deps)，默认那份碰到就算错
vi.mock('../models', () => ({
  getModelRegistry: () => {
    throw new Error('the default model registry must not be used in this test')
  },
  providerCredentialPort: {
    listProviders: () => {
      throw new Error('the default provider port must not be used in this test')
    }
  }
}))
// 分类器日志的落库：本文件的 deps.record 是 spy，默认那条路碰到 DAO 就算错
vi.mock('../../dao/classifierLogDao', () => ({
  classifierLogDao: {
    insert: cc.insert,
    prune: vi.fn(),
    list: vi.fn(() => []),
    getById: vi.fn(),
    scenes: vi.fn(() => []),
    clear: vi.fn()
  }
}))
vi.mock('../sessionRecords', () => ({
  sessionRecords: { isEphemeral: () => false, wasEphemeral: () => false }
}))

import {
  CLASSIFIER_MODEL_KEY,
  CLASSIFIER_PROVIDER_KEY,
  CLASSIFY_TIMEOUT_MS,
  COMMAND_RISK_QUESTIONS,
  COMMAND_RISK_SCENE,
  createCommandClassifier,
  riskFromAnswers,
  type CommandClassifierDeps
} from '../commandClassifier'
import { COMMAND_RISK_CATEGORY_CRITERIA } from '../commandRiskCore'

const OR_UUID = '0193a7c2-0000-7000-8000-00000000a0a1'
const CUSTOM_UUID = '0193a7c2-0000-7000-8000-00000000c0c1'
const JEV = '~typesafe/jev-latest'

/** 一份完整的概率表：read_only 0.93，其余按 local_change 0.04、destructive 0.03，别的 0 */
const PROBABILITIES: Record<string, number> = Object.fromEntries(
  COMMAND_RISK_CATEGORIES.map((c) => [
    c,
    c === 'read_only' ? 0.93 : c === 'local_change' ? 0.04 : c === 'destructive' ? 0.03 : 0
  ])
)

const choice = (
  picked: string,
  probabilities: Record<string, number> = PROBABILITIES,
  confidence = 0.93
): ClassifierAnswer => ({ type: 'choice', choice: picked, probabilities, confidence })

/** 一份完整的答案（read_only，把握 0.93） */
const ANSWERS: Record<string, ClassifierAnswer> = { category: choice('read_only') }

const EXPECTED_RISK = {
  category: 'read_only',
  confidence: 0.93,
  readOnly: 0.93,
  probabilities: PROBABILITIES,
  model: `openrouter/${JEV}`
}

const USAGE: NonNullable<ClassifierResult['usage']> = {
  input: 57,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 57,
  cost: { input: 0.00002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00002 }
}

const result = (
  over: Partial<ClassifierResult> = {},
  answers: Record<string, ClassifierAnswer> = ANSWERS
): ClassifierResult => ({
  api: 'typesafe-system-one',
  provider: 'openrouter',
  model: JEV,
  answers,
  usage: USAGE,
  stopReason: 'stop',
  timestamp: 0,
  ...over
})

const warnings = (): string[] => cc.warn.mock.calls.map((c) => String(c[0]))
/** 「命令分类没有完成」那一类告警 */
const failureWarnings = (): string[] => warnings().filter((w) => w.includes('命令分类没有完成'))

beforeEach(() => {
  cc.warn.mockReset()
  cc.info.mockReset()
  cc.debug.mockReset()
  cc.insert.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ─────────────────────────────────────────────────────────────────────────
// 常量与 riskFromAnswers

describe('常量与问题表', () => {
  it('CC-0 一道单选 category：准则键 = COMMAND_RISK_CATEGORIES（同顺序）、文字非空、说明点到 read_only 与 personal_data；超时 3000ms；两个设置键；场景名', () => {
    expect(Object.keys(COMMAND_RISK_QUESTIONS)).toEqual(['category'])
    const question = COMMAND_RISK_QUESTIONS.category
    expect(question.type).toBe('choice')
    if (question.type !== 'choice') throw new Error('unreachable')
    expect(Object.keys(question.criteria)).toEqual([...COMMAND_RISK_CATEGORIES])
    expect(question.criteria).toBe(COMMAND_RISK_CATEGORY_CRITERIA)
    for (const [key, text] of Object.entries(question.criteria)) {
      expect({ key, empty: text.trim() === '' }).toEqual({ key, empty: false })
    }
    expect(question.instructions.trim()).not.toBe('')
    expect(question.instructions).toContain('read_only')
    expect(question.instructions).toContain('personal_data')

    expect(CLASSIFY_TIMEOUT_MS).toBe(3000)
    expect(CLASSIFIER_PROVIDER_KEY).toBe('general.classifierProvider')
    expect(CLASSIFIER_MODEL_KEY).toBe('general.classifierModel')
    expect(COMMAND_RISK_SCENE).toBe('command-risk')
  })

  it('CC-0b 漂移守护：给每个类别都配上概率的答案 → riskFromAnswers 交回的过得了 agent-runtime 的 isCommandRisk', () => {
    const question = COMMAND_RISK_QUESTIONS.category
    if (question.type !== 'choice') throw new Error('unreachable')
    const keys = Object.keys(question.criteria)
    const probabilities = Object.fromEntries(keys.map((k) => [k, 1 / keys.length]))
    const risk = riskFromAnswers(
      { category: { type: 'choice', choice: keys[0], probabilities, confidence: 0.5 } },
      'p/m'
    )
    expect(risk).not.toBeNull()
    expect(isCommandRisk(risk)).toBe(true)
  })
})

describe('riskFromAnswers', () => {
  it('RA-1 完整的答案 → 恰为 CommandRisk 的形状，readOnly 就是 probabilities.read_only', () => {
    const risk = riskFromAnswers(ANSWERS, 'openrouter/x')
    expect(risk).toStrictEqual({ ...EXPECTED_RISK, model: 'openrouter/x' })
    expect(risk!.readOnly).toBe(risk!.probabilities.read_only)
    expect(Object.keys(risk!.probabilities)).toEqual([...COMMAND_RISK_CATEGORIES])
  })

  it('RA-2 概率表里多余的键丢掉；多余的答案也不进结果', () => {
    const risk = riskFromAnswers(
      {
        category: choice('read_only', { ...PROBABILITIES, network: 0.5, other: 0.1 }),
        sneaky: { type: 'bool', probability: 0.9 }
      },
      'p/m'
    )
    expect(risk).toStrictEqual({ ...EXPECTED_RISK, model: 'p/m' })
  })

  it.each<[string, ClassifierAnswer]>([
    ['bool', { type: 'bool', probability: 0.5 }],
    ['score', { type: 'score', score: 1, confidence: 0.5 }]
  ])('RA-3 category 答成 %s → null', (_label, answer) => {
    expect(riskFromAnswers({ category: answer }, 'p/m')).toBeNull()
  })

  it('RA-4 没有 category 的答案 → null', () => {
    expect(riskFromAnswers({}, 'p/m')).toBeNull()
    expect(riskFromAnswers({ other: choice('read_only') }, 'p/m')).toBeNull()
  })

  it.each([['dangerous'], ['Read_Only'], ['']])('RA-5 选了不认识的类别 %j → null', (picked) => {
    expect(riskFromAnswers({ category: choice(picked) }, 'p/m')).toBeNull()
  })

  it.each([...COMMAND_RISK_CATEGORIES])('RA-6 缺 %s 的概率 → null', (category) => {
    const { [category]: _omitted, ...rest } = PROBABILITIES
    expect(riskFromAnswers({ category: choice('read_only', rest) }, 'p/m')).toBeNull()
  })

  it.each<[string, number]>([
    ['-0.1', -0.1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY]
  ])('RA-7 某类概率为 %s → null（越界的分类不能当成只读）', (_label, value) => {
    expect(
      riskFromAnswers(
        { category: choice('read_only', { ...PROBABILITIES, secrets: value }) },
        'p/m'
      )
    ).toBeNull()
    expect(
      riskFromAnswers(
        { category: choice('read_only', { ...PROBABILITIES, read_only: value }) },
        'p/m'
      )
    ).toBeNull()
  })

  it.each<[string, number]>([
    ['1.2', 1.2],
    ['-0.1', -0.1],
    ['NaN', Number.NaN]
  ])('RA-8 把握为 %s → null；模型名为空 → null', (_label, confidence) => {
    expect(
      riskFromAnswers({ category: choice('read_only', PROBABILITIES, confidence) }, 'p/m')
    ).toBeNull()
    expect(riskFromAnswers(ANSWERS, '')).toBeNull()
  })

  it('RA-9 只校验形状：选中的不是最大概率也收；交回的 probabilities 不是答案里那个对象', () => {
    const probabilities = { ...PROBABILITIES, read_only: 0.1, destructive: 0.8 }
    const answer = choice('read_only', probabilities, 0.1)
    const risk = riskFromAnswers({ category: answer }, 'p/m')
    expect(risk).toMatchObject({ category: 'read_only', confidence: 0.1, readOnly: 0.1 })
    expect(risk!.probabilities).not.toBe(probabilities)
    probabilities.destructive = 0.99
    expect(risk!.probabilities.destructive).toBe(0.8)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// A 组：假 models + 假 port

interface FakeModels {
  getModelOfType: Mock<(type: string, provider: string, id: string) => unknown>
  getModelsOfType: Mock<(type: string, provider?: string) => Array<{ id: string }>>
  classify: Mock<
    (
      model: unknown,
      context: unknown,
      options?: { signal?: AbortSignal }
    ) => Promise<ClassifierResult>
  >
}

function fakeModels(): FakeModels {
  return {
    getModelOfType: vi.fn((type: string, provider: string, id: string) => ({
      type,
      provider,
      id,
      api: 'typesafe-system-one'
    })),
    getModelsOfType: vi.fn((_type: string, _provider?: string) => [] as Array<{ id: string }>),
    classify: vi.fn(async () => result())
  }
}

interface Harness {
  deps: CommandClassifierDeps
  models: FakeModels
  rows: ProviderRow[]
  settings: Record<string, string | undefined>
  modelsFn: Mock<() => FakeModels>
  portFn: Mock<() => { listProviders: () => ProviderRow[] }>
  record: Mock<(input: ClassifierLogInput) => void>
  records: () => ClassifierLogInput[]
}

/** 一份 deps：缺省是一行 uuid 的内置 openrouter、配好 Jev */
function harness(
  opts: { rows?: ProviderRow[]; settings?: Record<string, string | undefined> } = {}
): Harness {
  const models = fakeModels()
  const rows = opts.rows ?? [builtinRow('openrouter', { id: OR_UUID, displayName: 'OpenRouter' })]
  const settings = opts.settings ?? {
    [CLASSIFIER_PROVIDER_KEY]: OR_UUID,
    [CLASSIFIER_MODEL_KEY]: JEV
  }
  const modelsFn = vi.fn(() => models)
  const portFn = vi.fn(() => ({ listProviders: () => rows }))
  const record = vi.fn<(input: ClassifierLogInput) => void>()
  return {
    deps: {
      readSetting: (key) => settings[key],
      models: modelsFn as unknown as CommandClassifierDeps['models'],
      port: portFn,
      platform: 'darwin',
      record
    },
    models,
    rows,
    settings,
    modelsFn,
    portFn,
    record,
    records: () => record.mock.calls.map((c) => c[0])
  }
}

const BASH: CommandObjectInput = { channel: 'bash', command: 'ls -la', cwd: '/ws', sandboxed: true }
const CALL = { toolCallId: 'tc-1', sessionId: 'sess-1' }

/** 换掉 AbortSignal.timeout：每次交回一个可以手动触发的 signal，记下请求的毫秒数 */
function spyTimeouts(): Array<{ ms: number; fire: () => void; signal: AbortSignal }> {
  const made: Array<{ ms: number; fire: () => void; signal: AbortSignal }> = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const ac = new AbortController()
    made.push({
      ms,
      signal: ac.signal,
      fire: () => ac.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    })
    return ac.signal
  })
  return made
}

/** 一个等 options.signal 落下才收尾的 classify（resolve 成 aborted，或 reject） */
function waitsForAbort(mode: 'resolve-aborted' | 'reject'): FakeModels['classify'] {
  return vi.fn(
    (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) =>
      new Promise<ClassifierResult>((resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          if (mode === 'reject')
            reject(new DOMException('This operation was aborted', 'AbortError'))
          else
            resolve(
              result({ stopReason: 'aborted', errorMessage: 'Request was aborted', answers: {} })
            )
        })
      })
  )
}

/** misconfigured 日志的公共部分（这次调用的会话 / 工具调用 / 摘要 + 题目与 state） */
function expectMisconfigured(
  logged: ClassifierLogInput,
  expected: { provider: string; model: string; error: RegExp | string }
): void {
  expect(logged).toMatchObject({
    scene: 'command-risk',
    sessionId: 'sess-1',
    toolCallId: 'tc-1',
    subject: 'ls -la',
    provider: expected.provider,
    model: expected.model,
    status: 'misconfigured',
    ms: 0
  })
  expect(logged.error).toMatch(expected.error)
  expect(logged.answers).toBeUndefined()
  expect(logged.context.questions).toBe(COMMAND_RISK_QUESTIONS)
  expect(logged.context.state).toStrictEqual({
    command: 'ls -la',
    shell: 'bash',
    platform: 'darwin',
    sandboxed: true,
    workingDirectory: '/ws'
  })
}

describe('classify（假 models）', () => {
  it.each<[string, Record<string, string | undefined>]>([
    ['提供商键为空', { [CLASSIFIER_PROVIDER_KEY]: '', [CLASSIFIER_MODEL_KEY]: JEV }],
    ['模型键为空', { [CLASSIFIER_PROVIDER_KEY]: OR_UUID, [CLASSIFIER_MODEL_KEY]: '' }],
    ['两个都空', { [CLASSIFIER_PROVIDER_KEY]: '', [CLASSIFIER_MODEL_KEY]: '' }],
    ['都没写过', {}],
    ['只有空白', { [CLASSIFIER_PROVIDER_KEY]: '  ', [CLASSIFIER_MODEL_KEY]: ' \t' }]
  ])('CL-1 %s → null，不请求、不记日志、不告警', async (_label, settings) => {
    const h = harness({ settings })
    await expect(createCommandClassifier(h.deps).classify(BASH, CALL)).resolves.toBeNull()
    expect(h.models.classify).not.toHaveBeenCalled()
    expect(h.models.getModelOfType).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
    expect(cc.warn).not.toHaveBeenCalled()
  })

  it('CL-2 配置的提供商行不存在 → null；每次都记 misconfigured（provider = 行 id、model = 模型 id、ms 0、没有答案、错误点名 id）；告警一次；换一个 id 再告警', async () => {
    const h = harness({
      settings: { [CLASSIFIER_PROVIDER_KEY]: 'gone-row', [CLASSIFIER_MODEL_KEY]: JEV }
    })
    const classifier = createCommandClassifier(h.deps)
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    expect(h.records()).toHaveLength(2)
    for (const logged of h.records()) {
      expectMisconfigured(logged, { provider: 'gone-row', model: JEV, error: /gone-row/ })
    }
    expect(h.records()[0].error).toBe('Classifier provider gone-row no longer exists')
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('gone-row')

    h.settings[CLASSIFIER_PROVIDER_KEY] = 'also-gone'
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    expect(warnings()).toHaveLength(2)
    expect(warnings()[1]).toContain('also-gone')
    expect(h.records()).toHaveLength(3)
    expect(h.records()[2].provider).toBe('also-gone')
    expect(h.models.classify).not.toHaveBeenCalled()
  })

  it('CL-14 配置的提供商停用了 → null、misconfigured（provider = 行名）每次都记、告警一次；不查模型也不请求；重新启用照常分类', async () => {
    const h = harness({
      rows: [builtinRow('openrouter', { id: OR_UUID, isEnabled: false })]
    })
    const classifier = createCommandClassifier(h.deps)
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    expect(h.records()).toHaveLength(2)
    for (const logged of h.records()) {
      expectMisconfigured(logged, {
        provider: 'openrouter',
        model: JEV,
        error: 'Classifier provider openrouter is disabled'
      })
    }
    expect(warnings()).toHaveLength(1)
    expect(h.models.getModelOfType).not.toHaveBeenCalled()
    expect(h.models.classify).not.toHaveBeenCalled()

    h.rows[0].isEnabled = true
    await expect(classifier.classify(BASH, CALL)).resolves.toStrictEqual(EXPECTED_RISK)
    expect(h.records()[2].status).toBe('ok')
  })

  it('CL-3 模型不在目录里 → null、misconfigured（provider = pi slug、错误点名 <slug>/<id>），每次都记、告警一次', async () => {
    const h = harness()
    h.models.getModelOfType.mockReturnValue(undefined)
    const classifier = createCommandClassifier(h.deps)
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    expect(h.records()).toHaveLength(2)
    for (const logged of h.records()) {
      expectMisconfigured(logged, {
        provider: 'openrouter',
        model: JEV,
        error: `Classifier model openrouter/${JEV} is not in the model catalog`
      })
    }
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(`openrouter/${JEV}`)
    expect(h.models.classify).not.toHaveBeenCalled()
  })

  it('CL-4 内置行（uuid id、名字 "OpenRouter "）按 slug 找模型、risk.model 用 slug；自定义行按行 id；没名字的内置行 → misconfigured、不请求', async () => {
    const builtin = harness({
      rows: [builtinRow('OpenRouter ', { id: OR_UUID })]
    })
    const risk = await createCommandClassifier(builtin.deps).classify(BASH, CALL)
    expect(builtin.models.getModelOfType).toHaveBeenCalledWith('classifier', 'openrouter', JEV)
    expect(risk?.model).toBe(`openrouter/${JEV}`)
    expect(builtin.records()[0]).toMatchObject({ provider: 'openrouter', model: JEV })

    const custom = harness({
      rows: [customRow(CUSTOM_UUID)],
      settings: { [CLASSIFIER_PROVIDER_KEY]: CUSTOM_UUID, [CLASSIFIER_MODEL_KEY]: 'my-cls' }
    })
    const customRisk = await createCommandClassifier(custom.deps).classify(BASH, CALL)
    expect(custom.models.getModelOfType).toHaveBeenCalledWith('classifier', CUSTOM_UUID, 'my-cls')
    expect(customRisk?.model).toBe(`${CUSTOM_UUID}/my-cls`)
    expect(custom.records()[0]).toMatchObject({ provider: CUSTOM_UUID, model: 'my-cls' })

    const nameless = harness({ rows: [builtinRow('', { id: OR_UUID })] })
    const classifier = createCommandClassifier(nameless.deps)
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    expect(nameless.models.getModelOfType).not.toHaveBeenCalled()
    expect(nameless.models.classify).not.toHaveBeenCalled()
    expect(nameless.records()).toHaveLength(2)
    for (const logged of nameless.records()) {
      expectMisconfigured(logged, {
        provider: '',
        model: JEV,
        error: `Classifier provider ${OR_UUID} has no provider id`
      })
    }
    expect(warnings()).toHaveLength(1)
  })

  it.each<[string, CommandObjectInput, Record<string, string | boolean>]>([
    [
      'bash（带 cwd、圈住）',
      { channel: 'bash', command: 'ls -la', cwd: '/ws', sandboxed: true },
      {
        command: 'ls -la',
        shell: 'bash',
        platform: 'darwin',
        sandboxed: true,
        workingDirectory: '/ws'
      }
    ],
    [
      'powershell（没有 cwd）',
      { channel: 'powershell', command: 'Get-Date' },
      { command: 'Get-Date', shell: 'powershell', platform: 'darwin', sandboxed: false }
    ],
    [
      'ssh（带 host、带原因）',
      { channel: 'ssh', command: 'uptime', host: 'prod', unconfinedReason: 'remote' },
      { command: 'uptime', shell: 'ssh', platform: 'remote', sandboxed: false, remoteHost: 'prod' }
    ],
    [
      "sandboxed: 'yes'（非布尔的真值）",
      { channel: 'bash', command: 'ls', sandboxed: 'yes' as never, unconfinedReason: 'escalated' },
      { command: 'ls', shell: 'bash', platform: 'darwin', sandboxed: false }
    ]
  ])(
    'CL-5 %s → 交给分类器的 state 恰为这些键（没有原因、说明之类的多余字段）；日志里的 context.state 是同一份',
    async (_label, input, state) => {
      const h = harness()
      await createCommandClassifier(h.deps).classify(input, CALL)
      expect(h.models.classify).toHaveBeenCalledTimes(1)
      const context = h.models.classify.mock.calls[0][1] as { state: unknown }
      expect(context.state).toStrictEqual(state)
      expect(h.records()).toHaveLength(1)
      expect(h.records()[0].context.state).toStrictEqual(state)
      expect(h.records()[0].context).toBe(context)
    }
  )

  it('CL-6 问题就是 COMMAND_RISK_QUESTIONS 本身（同一个对象），日志里的也是', async () => {
    const h = harness()
    await createCommandClassifier(h.deps).classify(BASH, CALL)
    const context = h.models.classify.mock.calls[0][1] as { questions: unknown }
    expect(context.questions).toBe(COMMAND_RISK_QUESTIONS)
    expect(h.records()[0].context.questions).toBe(COMMAND_RISK_QUESTIONS)
  })

  it('CL-7 signal：没有调用方 signal → 交的就是 3000ms 的超时 signal；有 → 合一的 signal，调用方取消或超时触发都会让它落下；调用方已取消 → 一交过去就是落下的', async () => {
    // 没有调用方 signal
    {
      const timeouts = spyTimeouts()
      const h = harness()
      await createCommandClassifier(h.deps).classify(BASH, CALL)
      expect(timeouts.map((t) => t.ms)).toEqual([3000])
      expect(h.models.classify.mock.calls[0][2]?.signal).toBe(timeouts[0].signal)
      vi.restoreAllMocks()
    }
    // 有调用方 signal：调用方取消
    {
      const timeouts = spyTimeouts()
      const h = harness()
      const ac = new AbortController()
      let passed: AbortSignal | undefined
      h.models.classify.mockImplementation(async (_m, _c, options) => {
        passed = options?.signal
        expect(passed).not.toBe(ac.signal)
        expect(passed).not.toBe(timeouts[0].signal)
        expect(passed?.aborted).toBe(false)
        ac.abort()
        expect(passed?.aborted).toBe(true)
        return result()
      })
      await createCommandClassifier(h.deps).classify(BASH, { ...CALL, signal: ac.signal })
      expect(passed).toBeDefined()
      expect(timeouts.map((t) => t.ms)).toEqual([3000])
      vi.restoreAllMocks()
    }
    // 有调用方 signal：超时触发
    {
      const timeouts = spyTimeouts()
      const h = harness()
      const ac = new AbortController()
      let abortedAfterTimeout: boolean | undefined
      h.models.classify.mockImplementation(async (_m, _c, options) => {
        expect(options?.signal?.aborted).toBe(false)
        timeouts[0].fire()
        abortedAfterTimeout = options?.signal?.aborted
        return result()
      })
      await createCommandClassifier(h.deps).classify(BASH, { ...CALL, signal: ac.signal })
      expect(abortedAfterTimeout).toBe(true)
      expect(ac.signal.aborted).toBe(false)
      vi.restoreAllMocks()
    }
    // 调用方已经取消
    {
      spyTimeouts()
      const h = harness()
      const ac = new AbortController()
      ac.abort()
      let abortedAtCall: boolean | undefined
      h.models.classify.mockImplementation(async (_m, _c, options) => {
        abortedAtCall = options?.signal?.aborted
        return result({ stopReason: 'aborted', answers: {} })
      })
      await expect(
        createCommandClassifier(h.deps).classify(BASH, { ...CALL, signal: ac.signal })
      ).resolves.toBeNull()
      expect(abortedAtCall).toBe(true)
      expect(h.records()[0].status).toBe('aborted')
    }
  })

  it.each<['resolve-aborted' | 'reject']>([['resolve-aborted'], ['reject']])(
    'CL-8 超时触发（分类器 %s）→ null、timeout 日志；连着两次只告警一次、记两行',
    async (mode) => {
      const timeouts = spyTimeouts()
      const h = harness()
      h.models.classify = waitsForAbort(mode)
      const classifier = createCommandClassifier(h.deps)

      for (let i = 0; i < 2; i++) {
        const pending = classifier.classify(BASH, CALL)
        await vi.waitFor(() => expect(h.models.classify).toHaveBeenCalledTimes(i + 1))
        timeouts[i].fire()
        await expect(pending).resolves.toBeNull()
      }
      expect(h.records().map((r) => r.status)).toEqual(['timeout', 'timeout'])
      expect(h.records()[0]).toMatchObject({
        scene: 'command-risk',
        provider: 'openrouter',
        model: JEV,
        sessionId: 'sess-1',
        toolCallId: 'tc-1'
      })
      expect(failureWarnings()).toHaveLength(1)
      expect(failureWarnings()[0]).toContain('timeout')
      expect(warnings()).toHaveLength(1)
    }
  )

  it.each<[string, Partial<ClassifierResult>, string]>([
    [
      'error',
      { stopReason: 'error', errorMessage: 'System One API returned 500', answers: {} },
      'error: System One API returned 500'
    ],
    [
      'aborted（没有谁取消）',
      { stopReason: 'aborted', errorMessage: 'Request timed out', answers: {} },
      'aborted: Request timed out'
    ]
  ])(
    'CL-9 stopReason %s → null、failed 日志（error = "<stopReason>: <msg>"）；同一原因两次只告警一次、记两行；换原因再告警',
    async (_label, over, expectedError) => {
      const h = harness()
      h.models.classify.mockResolvedValue(result(over))
      const classifier = createCommandClassifier(h.deps)
      await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
      await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
      expect(h.records()).toHaveLength(2)
      for (const logged of h.records()) {
        expect(logged).toMatchObject({ status: 'failed', error: expectedError })
        expect(logged.answers).toBeUndefined()
      }
      expect(warnings()).toHaveLength(1)
      expect(warnings()[0]).toContain(expectedError)
      expect(cc.debug).not.toHaveBeenCalled()

      h.models.classify.mockResolvedValue(
        result({ stopReason: 'error', errorMessage: 'System One API returned 502', answers: {} })
      )
      await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
      expect(warnings()).toHaveLength(2)
      expect(warnings()[1]).toContain('502')
    }
  )

  it('CL-10 classify 抛错 → null、failed 日志 + 一条带原因的告警', async () => {
    const h = harness()
    h.models.classify.mockRejectedValue(new Error('socket hang up'))
    await expect(createCommandClassifier(h.deps).classify(BASH, CALL)).resolves.toBeNull()
    expect(h.records()).toHaveLength(1)
    expect(h.records()[0]).toMatchObject({ status: 'failed', error: 'socket hang up' })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('socket hang up')
  })

  const { install: _install, ...missingInstall } = PROBABILITIES
  it.each<[string, Record<string, ClassifierAnswer>]>([
    ['缺一类的概率', { category: choice('read_only', missingInstall) }],
    ['把握越界', { category: choice('read_only', PROBABILITIES, 1.2) }],
    ['概率越界', { category: choice('read_only', { ...PROBABILITIES, privilege: -0.1 }) }],
    ['不认识的类别', { category: choice('nope') }],
    ['题型不对', { category: { type: 'bool', probability: 0.9 } }]
  ])(
    'CL-11 stop 但答案%s → null、incomplete 日志（带答案）、一条告警，不记成功的 debug',
    async (_label, answers) => {
      const h = harness()
      h.models.classify.mockResolvedValue(result({}, answers))
      const classifier = createCommandClassifier(h.deps)
      await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
      await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
      expect(h.records()).toHaveLength(2)
      expect(h.records()[0]).toMatchObject({
        status: 'incomplete',
        answers,
        error: 'answers are incomplete or out of range',
        inputTokens: 57,
        cost: 0.00002
      })
      expect(warnings()).toHaveLength(1)
      expect(warnings()[0]).toContain('incomplete')
      expect(cc.debug).not.toHaveBeenCalled()
    }
  )

  it('CL-12 成功：恰为换算出的 risk（模型名用 pi 的 slug 而不是行 id）；ok 日志（场景、provider、裸模型 id、答案、用量、耗时）；一条不带行 uuid 的 debug、零告警', async () => {
    const h = harness()
    await expect(createCommandClassifier(h.deps).classify(BASH, CALL)).resolves.toStrictEqual(
      EXPECTED_RISK
    )
    expect(h.records()).toHaveLength(1)
    const logged = h.records()[0]
    expect(logged).toMatchObject({
      scene: 'command-risk',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      subject: 'ls -la',
      provider: 'openrouter',
      model: JEV,
      status: 'ok',
      answers: ANSWERS,
      inputTokens: 57,
      cost: 0.00002
    })
    expect(logged.error).toBeUndefined()
    expect(typeof logged.ms).toBe('number')
    expect(logged.ms).toBeGreaterThanOrEqual(0)

    expect(cc.warn).not.toHaveBeenCalled()
    expect(cc.debug).toHaveBeenCalledTimes(1)
    expect(String(cc.debug.mock.calls[0][0])).not.toContain(OR_UUID)
    expect(String(cc.debug.mock.calls[0][0])).toContain('read_only')
  })

  it('CL-13 每次都现读设置、现取 models() 与 port()：模型改成空 → 下一条不请求、不记；换模型 → 下一条用新 id', async () => {
    const h = harness()
    const classifier = createCommandClassifier(h.deps)
    await classifier.classify(BASH, CALL)
    expect(h.models.getModelOfType).toHaveBeenLastCalledWith('classifier', 'openrouter', JEV)
    expect(h.modelsFn).toHaveBeenCalledTimes(1)
    expect(h.portFn).toHaveBeenCalledTimes(1)

    h.settings[CLASSIFIER_MODEL_KEY] = ''
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    expect(h.models.classify).toHaveBeenCalledTimes(1)
    expect(h.records()).toHaveLength(1)

    h.settings[CLASSIFIER_MODEL_KEY] = 'cloudflare/clef'
    const risk = await classifier.classify(BASH, CALL)
    expect(h.models.getModelOfType).toHaveBeenLastCalledWith(
      'classifier',
      'openrouter',
      'cloudflare/clef'
    )
    expect(risk?.model).toBe('openrouter/cloudflare/clef')
    expect(h.models.classify).toHaveBeenCalledTimes(2)
    expect(h.modelsFn).toHaveBeenCalledTimes(2)
    expect(h.portFn).toHaveBeenCalledTimes(2)
    expect(h.records()[1].model).toBe('cloudflare/clef')
  })

  it.each<['resolve-aborted' | 'reject']>([['resolve-aborted'], ['reject']])(
    'CL-16 调用方取消（分类器 %s）→ null、aborted 日志、不告警；之后别的失败照样告警',
    async (mode) => {
      const h = harness()
      h.models.classify = waitsForAbort(mode)
      const ac = new AbortController()
      const classifier = createCommandClassifier(h.deps)
      const pending = classifier.classify(BASH, { ...CALL, signal: ac.signal })
      await vi.waitFor(() => expect(h.models.classify).toHaveBeenCalledTimes(1))
      ac.abort()
      await expect(pending).resolves.toBeNull()
      expect(h.records().map((r) => r.status)).toEqual(['aborted'])
      expect(cc.warn).not.toHaveBeenCalled()
      expect(cc.debug).not.toHaveBeenCalled()

      h.models.classify = vi.fn(async () => {
        throw new Error('socket hang up')
      })
      await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
      expect(warnings()).toHaveLength(1)
      expect(warnings()[0]).toContain('socket hang up')
    }
  )

  it.each<[string, CommandObjectInput, string]>([
    ['bash 原样', { channel: 'bash', command: 'git status' }, 'git status'],
    ['powershell 原样', { channel: 'powershell', command: 'Get-ChildItem' }, 'Get-ChildItem'],
    ['ssh 带主机', { channel: 'ssh', command: 'uptime', host: 'prod' }, '[ssh prod] uptime'],
    ['ssh 没有主机', { channel: 'ssh', command: 'uptime' }, 'uptime']
  ])('CL-17 日志的对象摘要：%s → %j', async (_label, input, subject) => {
    const h = harness()
    await createCommandClassifier(h.deps).classify(input, CALL)
    expect(h.records()[0].subject).toBe(subject)
  })

  it('CL-17 2000 字的命令原样交给 record（截断是日志服务的事）；配置有问题时也一样', async () => {
    const long = `echo ${'x'.repeat(1995)}`
    expect(long).toHaveLength(2000)
    const h = harness()
    await createCommandClassifier(h.deps).classify({ channel: 'bash', command: long }, CALL)
    expect(h.records()[0].subject).toBe(long)

    const broken = harness({
      settings: { [CLASSIFIER_PROVIDER_KEY]: 'gone-row', [CLASSIFIER_MODEL_KEY]: JEV }
    })
    await createCommandClassifier(broken.deps).classify({ channel: 'bash', command: long }, CALL)
    expect(broken.records()[0].subject).toBe(long)
  })

  it('CL-18 不给 opts：照常分类，日志里 sessionId / toolCallId 都没有', async () => {
    const h = harness()
    await expect(createCommandClassifier(h.deps).classify(BASH)).resolves.toStrictEqual(
      EXPECTED_RISK
    )
    expect(h.records()[0].sessionId).toBeUndefined()
    expect(h.records()[0].toolCallId).toBeUndefined()
    expect(h.records()[0].status).toBe('ok')
  })
})

describe('listModels（假 models）', () => {
  it('LM-1 只列已启用的行；停用的行不去查', async () => {
    const h = harness({
      rows: [
        builtinRow('openrouter', { id: OR_UUID }),
        builtinRow('opencode', { id: 'oc-row', isEnabled: false })
      ]
    })
    h.models.getModelsOfType.mockImplementation((_type, provider) =>
      provider === 'openrouter' ? [{ id: JEV }] : [{ id: 'jev-1.13' }]
    )
    const list = createCommandClassifier(h.deps).listModels()
    expect(list.map((m) => m.providerId)).toEqual([OR_UUID])
    expect(h.models.getModelsOfType.mock.calls.map((c) => c[1])).toEqual(['openrouter'])
  })

  it('LM-2 条目形状：id = <行 id>:<模型 id>，providerId 是行 id（uuid 内置行也是），isEnabled 1，sortOrder 是序号，capabilities "{}"，providerName = displayName || name', () => {
    const h = harness({
      rows: [
        builtinRow('openrouter', { id: OR_UUID, displayName: 'OpenRouter' }),
        customRow(CUSTOM_UUID, { name: 'My Proxy', displayName: '' })
      ]
    })
    h.models.getModelsOfType.mockImplementation((_type, provider) =>
      provider === 'openrouter' ? [{ id: JEV }, { id: 'cloudflare/clef' }] : [{ id: 'my-cls' }]
    )
    expect(createCommandClassifier(h.deps).listModels()).toStrictEqual([
      {
        id: `${OR_UUID}:${JEV}`,
        providerId: OR_UUID,
        modelId: JEV,
        isEnabled: 1,
        sortOrder: 0,
        capabilities: '{}',
        providerName: 'OpenRouter'
      },
      {
        id: `${OR_UUID}:cloudflare/clef`,
        providerId: OR_UUID,
        modelId: 'cloudflare/clef',
        isEnabled: 1,
        sortOrder: 1,
        capabilities: '{}',
        providerName: 'OpenRouter'
      },
      {
        id: `${CUSTOM_UUID}:my-cls`,
        providerId: CUSTOM_UUID,
        modelId: 'my-cls',
        isEnabled: 1,
        sortOrder: 0,
        capabilities: '{}',
        providerName: 'My Proxy'
      }
    ])
  })

  it('LM-3 行按 port 的顺序、模型按目录的顺序', () => {
    const h = harness({
      rows: [builtinRow('opencode', { id: 'oc' }), builtinRow('openrouter', { id: OR_UUID })]
    })
    h.models.getModelsOfType.mockImplementation((_type, provider) =>
      provider === 'opencode' ? [{ id: 'z' }, { id: 'a' }] : [{ id: 'm' }, { id: 'b' }]
    )
    expect(
      createCommandClassifier(h.deps)
        .listModels()
        .map((m) => `${m.providerId}/${m.modelId}`)
    ).toEqual(['oc/z', 'oc/a', `${OR_UUID}/m`, `${OR_UUID}/b`])
  })

  it('LM-4 某一行的 getModelsOfType 抛错：那一行跳过、恰一条告警，其余照列', () => {
    const h = harness({
      rows: [builtinRow('opencode', { id: 'oc' }), builtinRow('openrouter', { id: OR_UUID })]
    })
    h.models.getModelsOfType.mockImplementation((_type, provider) => {
      if (provider === 'opencode') throw new Error('catalog broken')
      return [{ id: JEV }]
    })
    const list = createCommandClassifier(h.deps).listModels()
    expect(list.map((m) => m.modelId)).toEqual([JEV])
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('catalog broken')
  })

  it('LM-5 没名字的内置行跳过，从不去查', () => {
    const h = harness({
      rows: [builtinRow('', { id: 'nameless' }), builtinRow('openrouter', { id: OR_UUID })]
    })
    h.models.getModelsOfType.mockImplementation(() => [{ id: JEV }])
    const list = createCommandClassifier(h.deps).listModels()
    expect(list.map((m) => m.providerId)).toEqual([OR_UUID])
    expect(h.models.getModelsOfType).toHaveBeenCalledTimes(1)
  })

  it("LM-6 按 ('classifier', <pi id>) 查：内置行用 slug、自定义行用行 id", () => {
    const h = harness({
      rows: [builtinRow('OpenRouter', { id: OR_UUID }), customRow(CUSTOM_UUID)]
    })
    createCommandClassifier(h.deps).listModels()
    expect(h.models.getModelsOfType.mock.calls).toEqual([
      ['classifier', 'openrouter'],
      ['classifier', CUSTOM_UUID]
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// B 组：真模型注册表 + 假 fetch

interface Recorded {
  url: string
  method: string | undefined
  headers: Headers
  body: Record<string, unknown>
  signal: AbortSignal | undefined
}

/** System One 线上形状的一道单选答案（12 个类别都有概率） */
const WIRE_PROBABILITIES: Record<string, number> = Object.fromEntries(
  COMMAND_RISK_CATEGORIES.map((c) => [
    c,
    c === 'read_only' ? 0.96 : c === 'personal_data' ? 0.04 : 0
  ])
)
const WIRE_ANSWERS = {
  category: {
    type: 'choice',
    choice: 'read_only',
    probabilities: WIRE_PROBABILITIES,
    confidence: 0.96
  }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

function stubFetch(
  respond: (req: Recorded) => Response | Promise<Response> = () =>
    jsonResponse({ answers: WIRE_ANSWERS, usage: { input_tokens: 9, output_tokens: 1 } })
): Recorded[] {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const req: Recorded = {
      url: input instanceof URL ? input.href : String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
      signal: init?.signal ?? undefined
    }
    calls.push(req)
    return respond(req)
  })
  return calls
}

function realHarness(opts: { key?: string; model?: string } = {}): {
  deps: CommandClassifierDeps
  registry: ReturnType<typeof createModelRegistry>
  record: Mock<(input: ClassifierLogInput) => void>
  records: () => ClassifierLogInput[]
} {
  const port = fakePort([
    builtinRow('openrouter', {
      id: OR_UUID,
      displayName: 'OpenRouter',
      apiKey: opts.key ?? 'sk-or-test'
    }),
    builtinRow('anthropic', { id: 'anthropic-row', apiKey: 'sk-ant-test' }),
    customRow(CUSTOM_UUID, { apiKey: 'sk-custom' })
  ])
  const registry = createModelRegistry({ port, authContext: fakeAuthContext() })
  const settings: Record<string, string> = {
    [CLASSIFIER_PROVIDER_KEY]: OR_UUID,
    [CLASSIFIER_MODEL_KEY]: opts.model ?? JEV
  }
  const record = vi.fn<(input: ClassifierLogInput) => void>()
  return {
    registry,
    record,
    records: () => record.mock.calls.map((c) => c[0]),
    deps: {
      readSetting: (key) => settings[key],
      models: () => registry.models,
      port: () => port,
      platform: 'darwin',
      record
    }
  }
}

describe('真模型注册表（假 fetch，不发真请求）', () => {
  it('RR-1 清单只来自已启用行的 classifier 类模型：只有 openrouter，modelId 与目录的 classifier 列表一致、含 Jev，没有对话模型', () => {
    stubFetch()
    const { deps, registry } = realHarness()
    const list = createCommandClassifier(deps).listModels()
    const catalog = registry.models.getModelsOfType('classifier', 'openrouter').map((m) => m.id)
    expect(catalog.length).toBeGreaterThan(0)
    expect(new Set(list.map((m) => m.providerId))).toEqual(new Set([OR_UUID]))
    expect(list.map((m) => m.modelId)).toEqual(catalog)
    expect(list.map((m) => m.modelId)).toContain(JEV)
    const chat = new Set(registry.models.getModelsOfType('chat', 'openrouter').map((m) => m.id))
    expect(chat.size).toBeGreaterThan(0)
    expect(list.filter((m) => chat.has(m.modelId))).toEqual([])
    expect(list.every((m) => m.providerName === 'OpenRouter')).toBe(true)
  })

  it('RR-2 opencode 与 cloudflare-workers-ai 的行也列出各自的 classifier 类模型', () => {
    const port = fakePort([
      builtinRow('opencode', { id: 'oc-row' }),
      builtinRow('cloudflare-workers-ai', { id: 'cf-row' })
    ])
    const registry = createModelRegistry({ port, authContext: fakeAuthContext() })
    const list = createCommandClassifier({
      readSetting: () => undefined,
      models: () => registry.models,
      port: () => port,
      platform: 'darwin',
      record: vi.fn()
    }).listModels()
    for (const [rowId, slug] of [
      ['oc-row', 'opencode'],
      ['cf-row', 'cloudflare-workers-ai']
    ]) {
      const expected = registry.models.getModelsOfType('classifier', slug).map((m) => m.id)
      expect(expected.length, slug).toBeGreaterThan(0)
      expect(list.filter((m) => m.providerId === rowId).map((m) => m.modelId)).toEqual(expected)
    }
  })

  it('RR-3 一次 System One 请求：POST https://openrouter.ai/api/v1/systemone、Bearer <行上的 key>；请求体带模型、CL-5 的 state、一道线上仍是 choice 的题；答案换成 risk；ok 日志带用量', async () => {
    const calls = stubFetch()
    const { deps, records } = realHarness()
    const risk = await createCommandClassifier(deps).classify(
      { channel: 'bash', command: 'git status', cwd: '/ws', sandboxed: false },
      CALL
    )
    expect(calls).toHaveLength(1)
    const [req] = calls
    expect(req.url).toBe('https://openrouter.ai/api/v1/systemone')
    expect(req.method).toBe('POST')
    expect(req.headers.get('authorization')).toBe('Bearer sk-or-test')
    expect(req.body.model).toBe(JEV)
    expect(req.body.state).toStrictEqual({
      command: 'git status',
      shell: 'bash',
      platform: 'darwin',
      sandboxed: false,
      workingDirectory: '/ws'
    })
    const questions = req.body.questions as Record<
      string,
      { type: string; criteria: Record<string, string> }
    >
    expect(Object.keys(questions)).toEqual(['category'])
    expect(questions.category.type).toBe('choice')
    expect(Object.keys(questions.category.criteria)).toEqual([...COMMAND_RISK_CATEGORIES])

    expect(risk).toStrictEqual({
      category: 'read_only',
      confidence: 0.96,
      readOnly: 0.96,
      probabilities: WIRE_PROBABILITIES,
      model: `openrouter/${JEV}`
    })
    expect(records()).toHaveLength(1)
    expect(records()[0]).toMatchObject({
      status: 'ok',
      provider: 'openrouter',
      model: JEV,
      subject: 'git status',
      inputTokens: 9,
      answers: WIRE_ANSWERS
    })
    expect(records()[0].cost).toBeGreaterThanOrEqual(0)
    expect(cc.warn).not.toHaveBeenCalled()
  })

  it('RR-4 没有 category 的应答 → failed；缺某一类概率 → incomplete；HTTP 401 → 恰一次请求后 failed（不重试）', async () => {
    const missingAnswer = stubFetch(() => jsonResponse({ answers: {} }))
    const h = realHarness()
    await expect(createCommandClassifier(h.deps).classify(BASH, CALL)).resolves.toBeNull()
    expect(missingAnswer).toHaveLength(1)
    expect(h.records()[0].status).toBe('failed')
    expect(h.records()[0].error).toMatch(/^error: /)
    expect(warnings()).toHaveLength(1)
    vi.unstubAllGlobals()

    const { secrets: _secrets, ...partial } = WIRE_PROBABILITIES
    const missingKey = stubFetch(() =>
      jsonResponse({ answers: { category: { ...WIRE_ANSWERS.category, probabilities: partial } } })
    )
    const h2 = realHarness()
    await expect(createCommandClassifier(h2.deps).classify(BASH, CALL)).resolves.toBeNull()
    expect(missingKey).toHaveLength(1)
    expect(h2.records()[0]).toMatchObject({ status: 'incomplete' })
    expect(h2.records()[0].answers).toBeDefined()
    vi.unstubAllGlobals()

    cc.warn.mockReset()
    const unauthorized = stubFetch(
      () =>
        new Response('{"error":{"message":"invalid key"}}', {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
    )
    const h3 = realHarness()
    await expect(createCommandClassifier(h3.deps).classify(BASH, CALL)).resolves.toBeNull()
    expect(unauthorized).toHaveLength(1)
    expect(h3.records()[0].status).toBe('failed')
    expect(warnings()).toHaveLength(1)
  })

  it('RR-5 行上没有 key → null，一次请求都不发，记一行 failed', async () => {
    const calls = stubFetch()
    const { deps, records } = realHarness({ key: '' })
    await expect(createCommandClassifier(deps).classify(BASH, CALL)).resolves.toBeNull()
    expect(calls).toHaveLength(0)
    expect(records()).toHaveLength(1)
    expect(records()[0]).toMatchObject({ status: 'failed', provider: 'openrouter', model: JEV })
    expect(records()[0].error).toMatch(/not configured|No API key/)
  })

  it('CL-15 没有 key：每条命令都记一行 failed 日志、都不发请求；主日志只告警一次', async () => {
    const calls = stubFetch()
    const { deps, records } = realHarness({ key: '' })
    const classifier = createCommandClassifier(deps)
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    expect(calls).toHaveLength(0)
    expect(records().map((r) => r.status)).toEqual(['failed', 'failed', 'failed'])
    expect(warnings()).toHaveLength(1)
    // pi 在认证那一步就停下（「Provider is not configured」/「No API key」，随 pi 的措辞）
    expect(warnings()[0]).toMatch(/not configured|No API key/)
  })

  it('RR-6 配置的是一个对话模型 → null、misconfigured、告警一次、不发请求', async () => {
    const calls = stubFetch()
    const probe = realHarness()
    const chatModel = probe.registry.models.getModelsOfType('chat', 'openrouter')[0].id
    const { deps, records } = realHarness({ model: chatModel })
    const classifier = createCommandClassifier(deps)
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    await expect(classifier.classify(BASH, CALL)).resolves.toBeNull()
    expect(calls).toHaveLength(0)
    expect(records().map((r) => r.status)).toEqual(['misconfigured', 'misconfigured'])
    expect(records()[0]).toMatchObject({ provider: 'openrouter', model: chatModel })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(`openrouter/${chatModel}`)
  })

  it('RR-7 fetch 挂住、超时触发 → null，请求的 init.signal 落下，记一行 timeout', async () => {
    const timeouts = spyTimeouts()
    const calls = stubFetch(
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError'))
          )
        })
    )
    const { deps, records } = realHarness()
    const pending = createCommandClassifier(deps).classify(BASH, CALL)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].signal?.aborted).toBe(false)
    timeouts.find((t) => t.ms === CLASSIFY_TIMEOUT_MS)!.fire()
    await expect(pending).resolves.toBeNull()
    expect(calls[0].signal?.aborted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(records().map((r) => r.status)).toEqual(['timeout'])
    expect(warnings()).toHaveLength(1)
  })

  it('RR-8 应答里选的是另一类（destructive）：照实交回，readOnly 取 read_only 的概率', async () => {
    const probabilities = Object.fromEntries(
      COMMAND_RISK_CATEGORIES.map((c) => [
        c,
        c === 'destructive' ? 0.8 : c === 'read_only' ? 0.2 : 0
      ])
    )
    stubFetch(() =>
      jsonResponse({
        answers: {
          category: { type: 'choice', choice: 'destructive', probabilities, confidence: 0.8 }
        }
      })
    )
    const { deps } = realHarness()
    const risk = await createCommandClassifier(deps).classify(
      { channel: 'bash', command: 'rm -rf build' },
      CALL
    )
    expect(risk).toMatchObject({ category: 'destructive', confidence: 0.8, readOnly: 0.2 })
  })
})
