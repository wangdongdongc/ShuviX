/**
 * 检测器（docs/auto-redaction-design.md §4）：
 *   - 与 magpie 的对照：magpie 自己的评测语料（fixtures/magpie-eval-cases.json）里，标成「保留」的值一个都不能被认出；
 *     标成「替换」、且是规则能认的那些（其余要靠本地模型），必须被认出；
 *   - 各类别的代表写法与 magpie 的去误报取舍；
 *   - 占位符：确定性、格式、写坏的形式也认得；已知值的原文匹配与流式的尾部压住。
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CATEGORIES_SENT_BY_DEFAULT } from '../categories'
import { detectSensitive, type Finding } from '../detect'
import { KnownValues } from '../known'
import {
  categoryOfPlaceholder,
  findPlaceholders,
  makePlaceholder,
  placeholderFor,
  placeholderSpans
} from '../placeholder'
import evalFixture from './fixtures/magpie-eval-cases.json'

interface EvalValue {
  V: string
  Kind: string
  Known?: string
}
interface EvalCase {
  ID: string
  From: string
  Text: string
  Mask?: EvalValue[]
  Keep?: EvalValue[]
}

const cases = (evalFixture as { cases: EvalCase[] }).cases

/** v 在 text 里被认出（整段或其中一段落在某处里） */
function caught(text: string, findings: Finding[], v: string): boolean {
  for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) {
    const end = i + v.length
    if (findings.some((f) => f.start < end && f.end > i)) return true
  }
  return false
}

/**
 * 语料里标成「替换」的值中，规则能认的那些（其余是外国手机号、英文散文里的密码、人名地址，magpie 靠本地模型认）。
 */
const RULE_CATCHES = new Set([
  'hunter2pass',
  'jane.smith@gmail.com',
  'wei.zhang@outlook.com',
  '13800138000',
  'li.na@qq.com',
  '4111 1111 1111 1111',
  'DE89 3704 0044 0532 0130 00',
  '11010519491231002X',
  'sk-proj-Qm7vT2xLk9RbW4nZpE6sJc8YhD3fGa5uKiN1oVr0',
  'Tr0ub4dor&3xyz',
  'Qw8!zLp3mN',
  'ghp_0123456789abcdefghijABCDEFGHIJ0123',
  // 语料里的 Google key 在 AIza 后面有 37 位（规则要正好 35 位），magpie 的规则也认不出，靠模型
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'rina.k@fastmail.com',
  'omar.haddad@proton.me'
])

/** 按默认策略会保持占位符的那些（magpie 默认关的几类照样认出，但默认照发 —— 对照时同样不算） */
const coveredByDefault = (text: string): Finding[] =>
  detectSensitive(text).filter(
    (f) => !(CATEGORIES_SENT_BY_DEFAULT as readonly string[]).includes(f.category)
  )

describe('与 magpie 的评测语料对照', () => {
  it('DT-1 标成保留的值一个都不认出（按默认策略）', () => {
    const wrong: string[] = []
    for (const c of cases) {
      const findings = coveredByDefault(c.Text)
      for (const v of c.Keep ?? []) {
        if (v.Known) continue
        if (caught(c.Text, findings, v.V)) wrong.push(`${c.ID}: ${v.Kind} ${JSON.stringify(v.V)}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('DT-2 规则能认的替换值全部认出', () => {
    const missed: string[] = []
    const seen = new Set<string>()
    for (const c of cases) {
      const findings = detectSensitive(c.Text)
      for (const v of c.Mask ?? []) {
        const full = RULE_CATCHES.has(v.V) ? v.V : [...RULE_CATCHES].find((x) => x.startsWith(v.V))
        if (!full) continue
        seen.add(full)
        if (!caught(c.Text, findings, v.V)) missed.push(`${c.ID}: ${v.Kind} ${JSON.stringify(v.V)}`)
      }
    }
    expect(missed).toEqual([])
    // 语料里确实有这些值（防止换了语料却静默地少测）
    expect([...RULE_CATCHES].filter((v) => !seen.has(v))).toEqual([])
  })
})

const categories = (s: string): Array<[string, string]> =>
  detectSensitive(s).map((f) => [f.category, f.value])

describe('各类别', () => {
  it('DT-3 密钥：各家前缀、JWT、PEM、URL 里的密码、字段赋值；同一段取规则表里靠前的', () => {
    const key = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
    expect(categories(`OPENAI_API_KEY=${key}`)).toEqual([['API_KEY', key]])
    expect(categories('ghp_' + 'a'.repeat(36))).toEqual([['API_KEY', 'ghp_' + 'a'.repeat(36)]])
    expect(categories('AKIA' + 'ABCDEFGHIJKLMNOP')).toEqual([['API_KEY', 'AKIAABCDEFGHIJKLMNOP']])
    // 嵌在更长的单词里不算
    expect(categories('task-' + 'a'.repeat(30))).toEqual([])
    const jwt = 'eyJhbGciOi' + 'JIUzI1NiJ9.eyJzdWIiOiIx' + 'MjM0In0.abcdefghijk'
    expect(categories(`Authorization: Bearer ${jwt}`)).toEqual([['TOKEN', jwt]])
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    expect(categories(`key:\n${pem}\n`)).toEqual([['PRIVATE_KEY', pem]])
    expect(categories('redis://:s3cretPass@cache:6379')).toEqual([['PASSWORD', 's3cretPass']])
    expect(categories('postgres://app:${DB_PASS}@db/x')).toEqual([])
    expect(categories('DB_PASSWORD=Tr0ub4dor&3xq')).toEqual([['SECRET', 'Tr0ub4dor&3xq']])
    expect(categories('"client_secret": "a8f3k2m9q7"')).toEqual([['SECRET', 'a8f3k2m9q7']])
  })

  it('DT-4 代码里只是提到秘密的写法不算', () => {
    expect(categories('const secretKey: Uint8Array;')).toEqual([])
    expect(categories('privateKey: toBase64Url(raw),')).toEqual([])
    expect(categories('token = process.env.API_TOKEN2')).toEqual([])
    expect(categories('SMTP_PASSWORD=********')).toEqual([])
  })

  it('DT-5 中日韩写法：密码是、密钥为（计数的数字不算）', () => {
    expect(categories('服务器密码是 Qw8!zLp3mN。')).toEqual([['PASSWORD', 'Qw8!zLp3mN']])
    expect(categories('密钥为12231241')).toEqual([['SECRET', '12231241']])
    expect(categories('密钥为 2048 位')).toEqual([])
    expect(categories('token 是 abc123def456')).toEqual([['SECRET', 'abc123def456']])
  })

  it('DT-6 邮箱：文件名、示例域名、URL 的 userinfo 不算', () => {
    expect(categories('mail li.na@qq.com now')).toEqual([['EMAIL', 'li.na@qq.com']])
    expect(categories('icon@2x.png logo@3x.jpg test@example.com')).toEqual([])
    expect(categories('postgres://app:hunter2pass@db.acme.cn:5432/x')).toEqual([
      ['PASSWORD', 'hunter2pass']
    ])
  })

  it('DT-7 号码：身份证、手机号、银行卡（Luhn）、IBAN；小数和裸 JSON 数字里的不算', () => {
    expect(categories('身份证号 11010519491231002X')).toEqual([['ID_CARD', '11010519491231002X']])
    expect(categories('电话 13800138000')).toEqual([['PHONE', '13800138000']])
    expect(categories('card 4111 1111 1111 1111')).toEqual([['BANK_CARD', '4111 1111 1111 1111']])
    expect(categories('card 4111 1111 1111 1112')).toEqual([])
    expect(categories('IBAN DE89 3704 0044 0532 0130 00 THEN')).toEqual([
      ['IBAN', 'DE89 3704 0044 0532 0130 00']
    ])
    expect(categories('height 5.13800138000')).toEqual([])
    expect(categories('{"ts": 13800138000}')).toEqual([])
  })

  it('DT-8 ID：UUID 里的一段不算，长十六进制只在凭据字段里算', () => {
    expect(categories('id 0f8fad5b-d9cb-469f-a165-713800138000')).toEqual([])
    const hex = 'a'.repeat(16) + '0123456789abcdef'
    expect(categories(`commit ${hex}`)).toEqual([])
    expect(categories(`api_token=${hex}`)).toEqual([['SECRET', hex]])
    expect(categories(`next_page_token=${hex}`)).toEqual([])
  })

  it('DT-9 细分的个人信息：生日、MAC、家目录用户名、公网 IP、存储桶', () => {
    expect(categories('DOB: 1990-03-05')).toEqual([['BIRTHDAY', '1990-03-05']])
    expect(categories('mac 3c:22:fb:1a:2b:9e')).toEqual([['MAC', '3c:22:fb:1a:2b:9e']])
    expect(categories('aa:bb:cc:dd:ee:ff')).toEqual([])
    expect(categories('open /Users/wangdd/Desktop/a.txt')).toEqual([['USERNAME', 'wangdd']])
    expect(categories('/home/runner/work')).toEqual([])
    expect(categories('connect to 52.14.8.201 now')).toEqual([['IP', '52.14.8.201']])
    expect(categories('192.168.1.10 and version 2.31.0.1 and 8.8.8.8')).toEqual([])
    expect(categories('s3://acme-prod-logs/2026/')).toEqual([['BUCKET', 'acme-prod-logs']])
  })

  it('DT-10 user@host：提示符和 ssh 目标拆成用户与主机，邮箱规则不再认它；别处的 git@github.com 仍是邮箱（同 magpie）', () => {
    expect(categories('deploy@build-07:~$ ls')).toEqual([
      ['USERNAME', 'deploy'],
      ['HOSTNAME', 'build-07']
    ])
    expect(categories('ssh -i k.pem alice@bastion.acme.io')).toEqual([
      ['USERNAME', 'alice'],
      ['HOSTNAME', 'bastion.acme.io']
    ])
    expect(categories('git@github.com:org/repo.git')).toEqual([['EMAIL', 'git@github.com']])
  })

  it('DT-11 已有的占位符里不再认出东西', () => {
    expect(categories('key {{API_KEY_k3v7x2mq}} and mail {{EMAIL_b5puzbfv}}')).toEqual([])
  })
})

describe('占位符', () => {
  const signer = {
    sign: (data: string): Uint8Array => createHmac('sha256', 'test-key').update(data).digest()
  }

  it('PH-1 同一个值同一个占位符；格式 {{REDACTED_CATEGORY_xxxxxxxx}}；类别不同则不同；旧写法照认', () => {
    const a = makePlaceholder(signer, 'API_KEY', 'sk-abc')
    expect(a).toMatch(/^\{\{REDACTED_API_KEY_[a-z2-7]{8}\}\}$/)
    expect(makePlaceholder(signer, 'API_KEY', 'sk-abc')).toBe(a)
    expect(makePlaceholder(signer, 'SECRET', 'sk-abc')).not.toBe(a)
    expect(placeholderSpans(`x ${a} y`)).toEqual([[2, 2 + a.length]])
    expect(categoryOfPlaceholder(a)).toBe('API_KEY')
    // 旧写法（v0.2.30 / v0.2.31）：认得、类别对；会话里已有旧写法的值沿用它
    const legacy = a.replace('REDACTED_', '')
    expect(placeholderSpans(legacy)).toEqual([[0, legacy.length]])
    expect(categoryOfPlaceholder(legacy)).toBe('API_KEY')
    expect(placeholderFor(signer, 'API_KEY', 'sk-abc', (p) => p === legacy)).toBe(legacy)
    expect(placeholderFor(signer, 'API_KEY', 'sk-abc', () => false)).toBe(a)
  })

  it('PH-1b 模型多写或少写了 REDACTED_：按表里有的那个认', () => {
    const fresh = '{{REDACTED_EMAIL_b5puzbfv}}'
    const legacy = '{{PHONE_c4qvzbfa}}'
    const known = (x: string): boolean => x === fresh || x === legacy
    expect(findPlaceholders('to {{EMAIL_b5puzbfv}} now', known)[0].placeholder).toBe(fresh)
    expect(findPlaceholders('call redacted_phone_c4qvzbfa', known)[0].placeholder).toBe(legacy)
    expect(findPlaceholders('{{REDACTED_SSN_b5puzbfv}}', known)).toEqual([])
  })

  it('PH-2 模型写坏的形式也认得：空格、少括号、改大小写；只认表里有的', () => {
    const p = '{{PHONE_b5puzbfv}}'
    const known = (x: string): boolean => x === p
    const forms = [
      '{{ PHONE_b5puzbfv }}',
      '{PHONE_b5puzbfv}}',
      'PHONE_b5puzbfv',
      'phone_B5PUZBFV',
      '{{PHONE_b5puzbfv}'
    ]
    for (const form of forms) {
      const text = `call ${form} now`
      const hits = findPlaceholders(text, known)
      expect(hits, form).toHaveLength(1)
      expect(text.slice(hits[0].start, hits[0].end), form).toBe(form)
      expect(hits[0].placeholder).toBe(p)
    }
    expect(findPlaceholders('call PHONE_aaaaaaaa now', known)).toEqual([])
    // 嵌在更长的单词里不算
    expect(findPlaceholders('xPHONE_b5puzbfv', known)).toEqual([])
  })
})

describe('已知值', () => {
  const known = new KnownValues()
  known.add({ value: 'Tr0ub4dor&3xq', placeholder: '{{SECRET_aaaaaaaa}}', category: 'SECRET' })
  known.add({ value: 'short', placeholder: '{{SECRET_bbbbbbbb}}', category: 'SECRET' })

  it('KV-1 换了说法的已知值按原文认出；短于 8 的不按已知值匹配', () => {
    const text = '数据库密码是 Tr0ub4dor&3xq，另一个是 short'
    const findings = detectSensitive('log in with Tr0ub4dor&3xq ok', known)
    expect(findings.map((f) => [f.rule, f.value])).toEqual([['known', 'Tr0ub4dor&3xq']])
    expect(known.spans(text).map((k) => k.value)).toEqual(['Tr0ub4dor&3xq'])
    expect(known.size).toBe(1)
  })

  it('KV-2 结尾是已知值的开头 → 返回那一段的长度', () => {
    expect(known.pendingTail('密码是 Tr0ub')).toBe(5)
    expect(known.pendingTail('密码是 T')).toBe(1)
    expect(known.pendingTail('密码是 Tr0ub4dor&3xq')).toBe(0)
    expect(known.pendingTail('nothing here')).toBe(0)
  })
})
