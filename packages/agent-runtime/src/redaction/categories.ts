/**
 * 敏感内容的类别 —— 检测器给每一处归的类，也是占位符里的那一段（`{{REDACTED_API_KEY_k3v7x2mq}}`）和
 * 策略里 `object.category` 的取值。对标 magpie（yetone/magpie v0.1.1548）的 kind 词汇。
 *
 * 分两组：`secret`（密钥、令牌、密码）与 `personal`（个人信息）。分组只影响三件事：
 *   - 小数 / JSON 数字的排除只对 personal 生效（noNumbers：一个小数的尾数、一个裸 JSON 数字不是电话号）；
 *   - 短十六进制 token 里的一段只对 personal 不算（noIDs：docker 短 ID 里的 11 位数字不是电话号）；
 *   - 记录里留的提示（hintOf）：secret 留 key 的前缀（`sk-`、`ghp_`），personal 只留首字符。
 *
 * 默认覆盖由内置第二层策略决定（docs/auto-redaction-design.md §4.1），不在这里：检测器照样认出全部类别（只是默认
 * 照发的几类在对话记录里照原样存，见 isKeptAsWritten）。
 */

export const SENSITIVE_CATEGORIES = [
  // ── secret ──
  'PRIVATE_KEY',
  'API_KEY',
  'TOKEN',
  'PASSWORD',
  'SECRET',
  // ── personal ──
  'EMAIL',
  'ID_CARD',
  'PHONE',
  'BANK_CARD',
  'SSN',
  'PASSPORT',
  'IBAN',
  'BIRTHDAY',
  'MAC',
  'SERIAL',
  'USERNAME',
  'HOSTNAME',
  'IP',
  'BUCKET'
] as const

export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number]

const SECRET_CATEGORIES: ReadonlySet<string> = new Set([
  'PRIVATE_KEY',
  'API_KEY',
  'TOKEN',
  'PASSWORD',
  'SECRET'
])

/** 这一类是不是个人信息（反之是密钥类） */
export function isPersonalCategory(category: string): boolean {
  return !SECRET_CATEGORIES.has(category)
}

/**
 * magpie 默认关的几类：几乎每个编程请求里都有（系统提示词里就有家目录），而且模型必须原样抄写这些
 * 路径和地址。内置第二层规则不覆盖它们，对话记录里也照原样存（isKeptAsWritten）。
 */
export const CATEGORIES_SENT_BY_DEFAULT: readonly SensitiveCategory[] = [
  'USERNAME',
  'HOSTNAME',
  'IP',
  'BUCKET'
]

const KEPT_AS_WRITTEN: ReadonlySet<string> = new Set(CATEGORIES_SENT_BY_DEFAULT)

/**
 * 这一类在对话记录里照原样存，不换成占位符（就是默认照发的那几类）。换了只有坏处：默认照样发出真值，模型
 * 回复里写出的真值又要换回占位符，短的用户名、桶名（agent、assets）在回复里整词出现就被换掉。策略要它们保持
 * 占位符时，由出口的兜底检测在每次请求里现换。
 */
export function isKeptAsWritten(category: string): boolean {
  return KEPT_AS_WRITTEN.has(category)
}
