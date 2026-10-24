/**
 * 用户输入的来源（inputOrigin.ts，2026-10-21）—— 宿主按连接盖章、落在会话存储 `SourceDoc` 里的那一项。
 *
 * 存储里的一项读回来时只认得的字段（`inputOriginOf`）：界面的来源标识、投影的 `metadata.origin`、审查与大纲的
 * 读者（agent-runtime `inputSource.ts`）都经它。这里钉形状判别的宽严：
 *
 *   IO-01a 认得的种类：只拷认得的字段（多出来的键丢掉、可选字段类型不对就丢掉），交出的是新对象
 *   IO-01b 认不出（种类不对、缺必填字段、字段类型不对、根本不是对象）→ undefined
 *   IO-01c `isDrivingOrigin` 只对 parent-session / session 为真，并把类型收窄到 DrivingSessionRef
 *   IO-01d `isMachineOrigin`（不是人打的）对 parent-session / session / trigger 为真，收窄到 MachineOrigin；
 *          触发器（2026-10-24）不是「驱动它的会话」—— isDrivingOrigin 对它为假
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { DrivingSessionRef } from './inputRequest'
import {
  inputOriginOf,
  isDrivingOrigin,
  isMachineOrigin,
  type HumanOrigin,
  type InputOrigin,
  type MachineOrigin,
  type TriggerOrigin
} from './inputOrigin'

const LOCAL = { kind: 'local' } as const
const REMOTE = {
  kind: 'remote',
  clientId: 'ws:4',
  address: '192.168.1.20',
  userAgent: 'UA'
} as const
const REMOTE_NO_UA = { kind: 'remote', clientId: 'ws:4', address: '192.168.1.20' } as const
const CHROME = { kind: 'chrome', installId: 'inst-1' } as const
const TELEGRAM = { kind: 'telegram', botId: 'b1', userId: 'u1', chatId: 'c1' } as const
const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const
const OTHER = { kind: 'session', sessionId: 'X', title: 'T' } as const
const TRIGGER = {
  kind: 'trigger',
  trigger: 'timer.fired',
  sourceId: 'timer:builtin:minute',
  bot: 'daily'
} as const
const TRIGGER_NO_SOURCE = { kind: 'trigger', trigger: 'timer.fired', bot: 'daily' } as const

describe('IO-01 · inputOriginOf', () => {
  it.each([
    ['local', LOCAL, LOCAL],
    ['local 带别的种类的字段 → 只留 kind', { kind: 'local', sessionId: 'P1' }, LOCAL],
    ['remote 四键原样', REMOTE, REMOTE],
    ['remote 多出来的键丢掉', { ...REMOTE, trusted: true, sessionId: 'P1' }, REMOTE],
    [
      'remote address 空串照留（连接上取不到地址）',
      { kind: 'remote', clientId: 'ws:4', address: '' },
      { kind: 'remote', clientId: 'ws:4', address: '' }
    ],
    ['remote 没有 userAgent', REMOTE_NO_UA, REMOTE_NO_UA],
    ['remote userAgent 空串 → 丢掉', { ...REMOTE, userAgent: '' }, REMOTE_NO_UA],
    ['remote userAgent 是数字 → 丢掉', { ...REMOTE, userAgent: 7 }, REMOTE_NO_UA],
    ['chrome 光秃秃的也算', { kind: 'chrome' }, { kind: 'chrome' }],
    ['chrome 带 installId', CHROME, CHROME],
    ['chrome installId 空串 → 丢掉', { kind: 'chrome', installId: '' }, { kind: 'chrome' }],
    ['chrome installId 是数字 → 丢掉', { kind: 'chrome', installId: 5 }, { kind: 'chrome' }],
    ['chrome 多出来的键丢掉', { ...CHROME, address: '1.2.3.4' }, CHROME],
    ['telegram 四键原样', TELEGRAM, TELEGRAM],
    ['telegram 多出来的键丢掉', { ...TELEGRAM, text: 'hi' }, TELEGRAM],
    ['parent-session 三键原样', PARENT, PARENT],
    [
      'parent-session title 不是字符串 → 丢掉',
      { ...PARENT, title: 7 },
      { kind: 'parent-session', sessionId: 'P1' }
    ],
    ['parent-session 多出来的键丢掉', { ...PARENT, trusted: true }, PARENT],
    ['session 三键原样', OTHER, OTHER],
    [
      'session title 不是字符串 → 丢掉',
      { ...OTHER, title: null },
      { kind: 'session', sessionId: 'X' }
    ],
    ['session 多出来的键丢掉', { ...OTHER, clientId: 'ws:4', evil: 'x' }, OTHER],
    ['trigger 带 sourceId → 四键原样', TRIGGER, TRIGGER],
    ['trigger 没有 sourceId → 三键', TRIGGER_NO_SOURCE, TRIGGER_NO_SOURCE],
    ['trigger sourceId 空串 → 丢掉', { ...TRIGGER, sourceId: '' }, TRIGGER_NO_SOURCE],
    ['trigger sourceId 是数字 → 丢掉', { ...TRIGGER, sourceId: 3 }, TRIGGER_NO_SOURCE],
    [
      'trigger 多出来的键（sessionId / message）丢掉',
      { ...TRIGGER, sessionId: 'S1', message: 'Tick.' },
      TRIGGER
    ]
  ] as const)('IO-01a %s', (_label, item, expected) => {
    const origin = inputOriginOf(item)
    expect(origin).toStrictEqual(expected)
    expect(origin).not.toBe(item)
  })

  /** telegram 三个 id 各缺一个 / 空串 / 数字 */
  const brokenTelegram = (['botId', 'userId', 'chatId'] as const).flatMap(
    (key): [string, unknown][] => [
      [
        `telegram 缺 ${key}`,
        Object.fromEntries(Object.entries(TELEGRAM).filter(([k]) => k !== key))
      ],
      [`telegram ${key} 空串`, { ...TELEGRAM, [key]: '' }],
      [`telegram ${key} 是数字`, { ...TELEGRAM, [key]: 1 }]
    ]
  )

  it.each<[string, unknown]>([
    ['remote clientId 空串', { ...REMOTE, clientId: '' }],
    ['remote 缺 clientId', { kind: 'remote', address: '192.168.1.20' }],
    ['remote clientId 是数字', { ...REMOTE, clientId: 4 }],
    ['remote 缺 address', { kind: 'remote', clientId: 'ws:4' }],
    ['remote address 是数字', { ...REMOTE, address: 42 }],
    ['remote 只有 kind', { kind: 'remote' }],
    ...brokenTelegram,
    ['session sessionId 空串', { kind: 'session', sessionId: '' }],
    ['session sessionId 是数字', { kind: 'session', sessionId: 42 }],
    ['parent-session sessionId 空串', { kind: 'parent-session', sessionId: '' }],
    ['parent-session 缺 sessionId', { kind: 'parent-session' }],
    ['trigger 缺 trigger', { kind: 'trigger', sourceId: 'timer:builtin:minute', bot: 'daily' }],
    ['trigger 缺 bot', { kind: 'trigger', trigger: 'timer.fired' }],
    ['trigger trigger 空串', { ...TRIGGER, trigger: '' }],
    ['trigger bot 空串', { ...TRIGGER, bot: '' }],
    ['trigger trigger 是数字', { ...TRIGGER, trigger: 1 }],
    ['trigger bot 是对象', { ...TRIGGER, bot: { name: 'daily' } }],
    ['trigger 只有 kind', { kind: 'trigger' }],
    ['种类 hook（更新的版本写的）', { kind: 'hook', sessionId: 'H1' }],
    ['种类 Local（大小写不对）', { kind: 'Local' }],
    ['种类 user', { kind: 'user', sessionId: 'P1' }],
    ['没有 kind', { clientId: 'ws:4', address: '192.168.1.20' }],
    ['null', null],
    ['数组', []],
    ['字符串', 'local'],
    ['数字', 42],
    ['undefined', undefined]
  ])('IO-01b %s → undefined', (_label, item) => {
    expect(inputOriginOf(item)).toBeUndefined()
  })
})

describe('IO-01c · isDrivingOrigin', () => {
  it.each([
    [LOCAL, false],
    [REMOTE, false],
    [{ kind: 'chrome' } as const, false],
    [TELEGRAM, false],
    [PARENT, true],
    [OTHER, true]
  ] as const)('IO-01c %o → %s', (origin, expected) => {
    expect(isDrivingOrigin(origin)).toBe(expected)
  })

  it('IO-01c 类型收窄：真 → DrivingSessionRef，假 → HumanOrigin | TriggerOrigin', () => {
    const origins: InputOrigin[] = [LOCAL, REMOTE, CHROME, TELEGRAM, PARENT, OTHER]
    const driving: DrivingSessionRef[] = []
    const human: HumanOrigin[] = []
    for (const origin of origins) {
      if (isDrivingOrigin(origin)) {
        expectTypeOf(origin).toEqualTypeOf<DrivingSessionRef>()
        driving.push(origin)
      } else {
        expectTypeOf(origin).toEqualTypeOf<HumanOrigin | TriggerOrigin>()
        if (origin.kind !== 'trigger') human.push(origin)
      }
    }
    expect(driving).toStrictEqual([PARENT, OTHER])
    expect(human.map((origin) => origin.kind)).toStrictEqual([
      'local',
      'remote',
      'chrome',
      'telegram'
    ])
  })
})

describe('IO-01d · isMachineOrigin', () => {
  it.each([
    [LOCAL, false],
    [REMOTE, false],
    [CHROME, false],
    [TELEGRAM, false],
    [PARENT, true],
    [OTHER, true],
    [TRIGGER, true],
    [TRIGGER_NO_SOURCE, true]
  ] as const)('IO-01d %o → %s', (origin, expected) => {
    expect(isMachineOrigin(origin)).toBe(expected)
  })

  it('IO-01d 触发器不是驱动它的会话：isDrivingOrigin(trigger) 为假', () => {
    expect(isDrivingOrigin(TRIGGER)).toBe(false)
    expect(isDrivingOrigin(TRIGGER_NO_SOURCE)).toBe(false)
  })

  it('IO-01d 类型收窄：真 → MachineOrigin，假 → HumanOrigin', () => {
    const origins: InputOrigin[] = [LOCAL, REMOTE, CHROME, TELEGRAM, PARENT, OTHER, TRIGGER]
    const machine: MachineOrigin[] = []
    const human: HumanOrigin[] = []
    for (const origin of origins) {
      if (isMachineOrigin(origin)) {
        expectTypeOf(origin).toEqualTypeOf<MachineOrigin>()
        machine.push(origin)
      } else {
        expectTypeOf(origin).toEqualTypeOf<HumanOrigin>()
        human.push(origin)
      }
    }
    expect(machine).toStrictEqual([PARENT, OTHER, TRIGGER])
    expect(human.map((origin) => origin.kind)).toStrictEqual([
      'local',
      'remote',
      'chrome',
      'telegram'
    ])
  })
})
