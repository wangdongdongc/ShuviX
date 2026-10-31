/**
 * ExperimentalTag —— 实验功能入口上的小标签（「实验」/ Beta），悬停说明承诺范围。
 *
 * 只放在「决定开始用」的入口（设置 tab、侧栏分组标题、新建对话框、MCP 设置里的那一行），不放在每次使用的地方
 * （每条回复的朗读按钮、每个 bot 行）—— 那里出现得太频繁，只会变成噪音。
 *
 * 描边样式与设置页的 PlatformTag 同一副：它说的是「这个功能是什么性质」；侧栏行上实底灰的
 * 「已覆盖 / 已停用」说的是「这一行现在什么状态」，两者不能长成一样。
 * 字重 / 大小写 / 字距显式写死：它会被放进 uppercase 的分组标题和 semibold 的对话框标题里。
 *
 * 哪些功能算实验、各自的悬停说明，唯一真源是 chat-protocol 的 EXPERIMENTAL_FEATURES。chat-ui 的扩展选择器
 * 有一份同样子的副本（chat-ui `common/ExperimentalTag.tsx`：chat-ui 不能依赖 app-shell），改样子两处一起改。
 */
import { useTranslation } from 'react-i18next'
import {
  EXPERIMENTAL_FEATURES,
  type ExperimentalFeature
} from '@shuvix/chat-protocol/experimentalFeatures'

export function ExperimentalTag({ feature }: { feature: ExperimentalFeature }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      data-experimental={feature}
      title={t(EXPERIMENTAL_FEATURES[feature])}
      className="shrink-0 text-[9px] font-medium normal-case tracking-normal leading-none px-[3px] py-0.5 rounded border border-accent/40 text-accent whitespace-nowrap"
    >
      {t('experimental.tag')}
    </span>
  )
}
