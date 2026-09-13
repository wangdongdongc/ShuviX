/**
 * bot 会话的形态判定 —— `boundBotOf` / `isBotSessionSettings`。
 *
 * 一条 bot 会话绑定一个 bot（`settings.bot`），而它是一条**普通有根会话**：根 Agent 跑在基座
 * `bot` 上，人设与记忆经 systemContext 注入。本模块是两个宿主与三层 UI 共用的那一份口径，
 * 所以钉的全是「别在各处手写 `!!settings.bot`」会漏掉的边角：trim、非字符串、settings 整个为 null。
 */
import { describe, expect, it } from 'vitest'
import { isBotSessionSettings, boundBotOf, type BotSessionShape } from './botSession'

/** 两个谓词一起看 —— 形态判定的全部输出面 */
const verdict = (settings?: BotSessionShape | null): [string | undefined, boolean] => [
  boundBotOf(settings),
  isBotSessionSettings(settings)
]

describe('boundBotOf / isBotSessionSettings', () => {
  it('PS-1 boundBotOf trim 后返回名字；空 / 纯空白 / 非字符串 / null → undefined，不抛', () => {
    // trim 在这一层做，是因为写入侧（sessionService.create）也 trim 一次 —— 两边都做才
    // 不必假设对方做过。非字符串来自数据损坏或手改 DB：那不是一条 bot 会话，是一行坏数据
    expect(boundBotOf({ bot: 'scout' })).toBe('scout')
    expect(boundBotOf({ bot: '  scout  ' })).toBe('scout')

    const notBound: unknown[] = [
      undefined,
      null,
      {},
      { bot: '' },
      { bot: '   \t\n' },
      { bot: 42 },
      { bot: true },
      { bot: ['scout'] },
      { bot: { name: 'scout' } }
    ]
    for (const settings of notBound) {
      expect(() => boundBotOf(settings as BotSessionShape), JSON.stringify(settings)).not.toThrow()
      expect(boundBotOf(settings as BotSessionShape), JSON.stringify(settings)).toBeUndefined()
    }
  })

  it('PS-2 isBotSessionSettings 恒为布尔，且在每种输入上与 boundBotOf 一致', () => {
    // 返回 `string | undefined` 的谓词会被写成 `if (x)` 到处用，然后某天有人拿它当名字用。
    // 两个函数一个给名字、一个给判定，口径必须逐例相同
    const inputs: unknown[] = [
      { bot: 'scout' },
      { bot: '  scout  ' },
      { bot: '' },
      { bot: '   ' },
      { bot: 42 },
      {},
      null,
      undefined
    ]
    for (const settings of inputs) {
      const [name, isBot] = verdict(settings as BotSessionShape)
      expect(typeof isBot, JSON.stringify(settings)).toBe('boolean')
      expect(isBot, JSON.stringify(settings)).toBe(!!name)
    }
  })
})
