/**
 * ExperimentalTag —— app-shell `common/ExperimentalTag.tsx` 的同样子副本，给输入框的扩展选择器用
 * （chat-ui 不能依赖 app-shell；app-shell 的 DOM 用例又整份 mock 掉 `@shuvix/chat-ui`，所以也不反过来转出口）。
 * 改样子两处一起改；哪些功能算实验、悬停说明，唯一真源仍是 chat-protocol 的 EXPERIMENTAL_FEATURES。
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
