/**
 * 「让 agent 帮我设置」的提示词（2026-10-19，docs/network-policy/design.md §8）—— 设置 → 网络访问的按钮新建一条会话
 * （勾上 shuvix 知识库）并把它填进输入框，不自动发送；「复制提示词」复制同一段。按界面语言取模板，再带上此刻的事实
 * （端口、是否无头、准入策略的状态、能打开的地址、连着的设备与它们的设备 ID、最近被拒的几条）—— agent 据此问用户、
 * 读知识库的 network-policy 条目、写 network-admission。纯函数，单测直接引。
 */
import type { NetworkStatus } from '../../../../shared/network'

type T = (key: string, options?: Record<string, unknown>) => string

/** 提示词里列几条最近的拒绝 */
const PROMPT_DENIALS = 5

/** 提示词是纯文本（进输入框、进剪贴板），不做 HTML 转义 —— 不依赖全局的 i18next 配置 */
const PLAIN = { interpolation: { escapeValue: false } } as const

/** 新会话勾上的知识库：ShuviX 自己的手册（network-policy / policy-md 条目在里面） */
export const NETWORK_POLICY_CHAT_KNOWLEDGE = ['shuvix'] as const

export function buildNetworkPolicyPrompt(t: T, status: NetworkStatus): string {
  const state = t(`settings.networkPromptState_${status.admission}`)
  const none = t('settings.networkPromptNone')
  const addresses = status.addresses.length > 0 ? status.addresses.join('  ') : none
  const clients =
    status.clients.length > 0
      ? status.clients
          .map((client) =>
            t('settings.networkPromptClient', {
              ...PLAIN,
              address: client.remoteAddress,
              agent: client.userAgent || '?',
              device: client.device || none
            })
          )
          .join('\n')
      : none
  const denials =
    status.denials.length > 0
      ? status.denials
          .slice(0, PROMPT_DENIALS)
          .map((denial) =>
            t('settings.networkPromptDenial', {
              ...PLAIN,
              address: denial.address,
              device: denial.device || none,
              what: denial.summary,
              rule: denial.rule
            })
          )
          .join('\n')
      : none
  return t('settings.networkPrompt', {
    ...PLAIN,
    port: status.port,
    headless: status.headless ? t('settings.networkPromptHeadless') : '',
    state,
    addresses,
    clients,
    denials
  })
}
