import { describe, it, expect } from 'vitest'
import en from './locales/en.json'
import zh from './locales/zh.json'
import ja from './locales/ja.json'

/**
 * 三语键集合齐平 —— UI 文案的唯一真源就是这三份 JSON，缺键的表现是界面上直接
 * 露出 `toolCall.imageMissing` 这样的原始键名（i18next 的兜底），而不是报错。
 * 加文案时漏译一门语言几乎无感，故用一条常驻断言把它钉住。
 */
function flatten(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key)
  )
}

/** a 有而 b 没有的键（排序后便于读失败输出） */
function missing(a: string[], b: string[]): string[] {
  const known = new Set(b)
  return a.filter((k) => !known.has(k)).sort()
}

/** 按扁平键路径取叶子值（非字符串叶子返回 undefined） */
function leaf(value: unknown, path: string): string | undefined {
  const found = path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value)
  return typeof found === 'string' ? found : undefined
}

/** 一句文案里的 `{{x}}` 插值名（去重、排序） */
function placeholders(text: string): string[] {
  const names = [...text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((m) => m[1])
  return [...new Set(names)].sort()
}

describe('i18n 语言包', () => {
  const keys = { en: flatten(en), zh: flatten(zh), ja: flatten(ja) }

  it('zh / ja 与 en 的键集合完全一致', () => {
    expect({
      zhMissing: missing(keys.en, keys.zh),
      zhExtra: missing(keys.zh, keys.en),
      jaMissing: missing(keys.en, keys.ja),
      jaExtra: missing(keys.ja, keys.en)
    }).toEqual({ zhMissing: [], zhExtra: [], jaMissing: [], jaExtra: [] })
  })

  it('键数量三语相等', () => {
    expect(keys.en.length).toBeGreaterThan(0)
    expect([keys.zh.length, keys.ja.length]).toEqual([keys.en.length, keys.en.length])
  })

  /**
   * L：`bot.*` 是宿主往会话里说的通告（失败句 / 回落提示 / 排队回执），插值就是它们的全部
   * 信息量 —— 一门语言漏了 `{{agent}}`，运行期不报错，只是那句话里少了它本该点名的东西
   * （i18next 对缺参的插值露出原始占位符）。键集合齐平那条断言看不见这种漏译。
   */
  it('L-1 bot.* 每个键的 {{x}} 占位符集合三语一致', () => {
    const botKeys = keys.en.filter((k) => k.startsWith('bot.'))
    expect(botKeys).toContain('bot.stepNoAgent')
    // 抽一句钉住「确实在比较插值」：stepNoAgent 三语都点名 agent 与 name
    expect(placeholders(leaf(en, 'bot.stepNoAgent')!)).toEqual(['agent', 'name'])

    const drift = Object.fromEntries(
      botKeys
        .map((k) => [
          k,
          {
            en: placeholders(leaf(en, k) ?? ''),
            zh: placeholders(leaf(zh, k) ?? ''),
            ja: placeholders(leaf(ja, k) ?? '')
          }
        ])
        .filter(([, v]) => {
          const { en: a, zh: b, ja: c } = v as Record<'en' | 'zh' | 'ja', string[]>
          return a.join() !== b.join() || a.join() !== c.join()
        })
    )
    expect(drift).toEqual({})
  })

  /**
   * L-2：会话内切换档案（输入框的档案选择器 + 「默认项目/聊天智能体」设置组）已下线，
   * 它们的文案不该还留在语言包里 —— 留着的键没有任何 UI 会读，却会让下一个人以为那个入口
   * 还在。`shuvix-session-awareness` 随后也整个退役，它给用户看的那句文案
   * （`tool.subAgentSessionAwareness`）同样不该留。zh / ja 的键集合由上面那条齐平断言自动跟随。
   */
  it('L-2 en 无 agentProfile.* 与默认智能体设置组的键；会话感知文案三语都已删', () => {
    expect(keys.en.filter((k) => k.startsWith('agentProfile.'))).toEqual([])
    // 按叶名匹配而不钉死章节：这组键曾在 settings 章节下，搬到别的章节复活同样算复活
    const GONE =
      /\.(defaultAgentGroup|defaultAgentGroupDesc|defaultProjectAgentRow|defaultProjectAgentDesc|defaultChatAgentRow|defaultChatAgentDesc)$/
    expect(keys.en.filter((k) => GONE.test(k))).toEqual([])

    // `shuvix-session-awareness` 这个键本身也退役了（子会话的 agent_profile 只看「不是基座」），
    // 它给用户看的那句定义随之一起走 —— 留着的文案会让下一个人以为卡片上还有这一行
    for (const lang of ['en', 'zh', 'ja'] as const) {
      expect(keys[lang], lang).not.toContain('tool.subAgentSessionAwareness')
    }
    // 正控制组：邻居键还在
    expect(keys.en).toContain('tool.subAgentProjectAwareness')
  })
})
