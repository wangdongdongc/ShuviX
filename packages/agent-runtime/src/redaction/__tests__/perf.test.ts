/**
 * 检测器的性能（docs/auto-redaction-design.md §4.5）：JS 的正则会回溯，每条规则都得在构造好的对抗输入上
 * 保持线性 —— 输入长 4 倍，耗时不能超过约 8 倍（线性约 4 倍，平方级约 16 倍），且有绝对上限。
 * 再用真实规模的上下文量一次每 10 万字符的耗时。
 *
 * 计时取多次里最快的一次，减少机器抖动的影响；体量选得让一次检测落在几毫秒到几十毫秒。
 */
import { describe, expect, it } from 'vitest'
import { detectSensitive } from '../detect'
import { KnownValues } from '../known'

function fastest(run: () => void, times = 3): number {
  let best = Infinity
  for (let i = 0; i < times; i++) {
    const t0 = performance.now()
    run()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

/** 构造对抗输入的办法：给定大致长度 n 返回文本 */
const ADVERSARIAL: Record<string, (n: number) => string> = {
  // 邮箱：一长串本地部分里只有一个 @、很多个 @
  'long local part, one @': (n) => 'a'.repeat(n) + '@',
  'many @': (n) => 'a@'.repeat(n / 2),
  'dotted domain without tld': (n) => 'x@' + 'a.'.repeat(n / 2) + '1',
  // 前缀类 key：超长的 key、连续的前缀
  'one huge sk- key': (n) => 'sk-' + 'A'.repeat(n),
  'repeated eyJ': (n) => 'eyJ'.repeat(n / 3),
  'repeated gh': (n) => ' gh'.repeat(n / 3),
  // PEM：一串 BEGIN 没有 END、配一个对不上的 END
  'BEGIN without END': (n) => '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(n / 32),
  'BEGIN with wrong END': (n) =>
    '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(n / 32) + '-----END CERTIFICATE-----',
  // 字段名：一长串名字里很多个 password、很多个赋值
  'long identifier of names': (n) => 'password'.repeat(n / 8) + '=',
  'many assignments': (n) => 'password=x\n'.repeat(n / 11),
  'url schemes': (n) => 'a://b:'.repeat(n / 6),
  // 号码：长串数字、带空格的数字、长串十六进制
  digits: (n) => '1'.repeat(n),
  'spaced digits': (n) => '1 '.repeat(n / 2),
  'hex and colons': (n) => 'ab:'.repeat(n / 3),
  'dotted numbers': (n) => '1.'.repeat(n / 2),
  // 中日韩：满篇的「是」、名字后面跟一长串值
  'chinese copulas': (n) => '这是一个是'.repeat(n / 5),
  'cjk name with long value': (n) => '密码是' + 'a1'.repeat(n / 2),
  // 行首规则：很多行 hostname:
  'hostname lines': (n) => 'hostname: a.b.c.d.e\n'.repeat(n / 20),
  'shell prompts': (n) => 'u@h:~$ \n'.repeat(n / 8),
  'ssh words': (n) => 'ssh '.repeat(n / 4) + 'a@b'
}

describe('对抗输入：线性', () => {
  for (const [name, make] of Object.entries(ADVERSARIAL)) {
    it(`PF ${name}`, () => {
      const n = 50_000
      const small = make(n)
      const large = make(n * 4)
      detectSensitive(small) // 预热
      const tSmall = fastest(() => detectSensitive(small))
      const tLarge = fastest(() => detectSensitive(large))
      // 太快的不比倍数（计时精度不够），只看绝对值
      if (tSmall > 2)
        expect(tLarge / tSmall, `${tSmall.toFixed(1)}ms → ${tLarge.toFixed(1)}ms`).toBeLessThan(8)
      expect(tLarge, `${large.length} chars`).toBeLessThan(800)
    })
  }
})

/** 真实规模的上下文：代码、日志、压缩过的 JS、base64、超长单行，夹着少量秘密 */
function realisticContext(chars: number): string {
  const blocks = [
    'export function handler(req, res) {\n  const user = req.body.user_id\n  return res.json({ ok: true, id: "0f8fad5b-d9cb-469f-a165-70867728950e" })\n}\n',
    '2026-10-25T09:14:03.120Z INFO request id=req_011CUq7vHn3kLp9WmT2xZb4R path=/api/v1/orders status=200 ms=12\n',
    '!function(e,t){"use strict";var n=function(e){return e&&e.__esModule?e:{default:e}};t.a=n(e)}(this,{});'.repeat(
      4
    ) + '\n',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='.repeat(
      3
    ) + '\n',
    '| col a | col b | col c |\n|---|---|---|\n| 1.25 | 3.50 | 13800138000.5 |\n',
    'DB_PASSWORD=Tr0ub4dor&3xq\nOPENAI_API_KEY=sk-proj-' +
      'Qm7vT2xLk9RbW4nZpE6sJc8YhD3fGa5u' +
      '\n',
    '用户反馈：登录后页面空白，联系邮箱 li.na@qq.com，电话 13800138000。\n',
    'a'.repeat(2000) + '\n'
  ]
  let out = ''
  for (let i = 0; out.length < chars; i++) out += blocks[i % blocks.length]
  return out
}

describe('真实规模', () => {
  it('PF-real 每 10 万字符的检测耗时在预算内，带已知值时也是', () => {
    const text = realisticContext(1_000_000)
    const known = new KnownValues()
    for (let i = 0; i < 200; i++) {
      known.add({
        value: `known-secret-${i}-xyz`,
        placeholder: `{{SECRET_${'a'.repeat(8)}}}`,
        category: 'SECRET'
      })
    }
    detectSensitive(text.slice(0, 100_000), known) // 预热
    const ms = fastest(() => detectSensitive(text, known), 2)
    const per100k = (ms / text.length) * 100_000
    // 预算：Mac mini 上实测约为它的几分之一；超了说明某条规则退化了
    expect(per100k, `${per100k.toFixed(1)}ms per 100k chars`).toBeLessThan(60)
  })
})
