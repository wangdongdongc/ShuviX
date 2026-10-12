/**
 * 监视器（桌面设置页）—— 运行时观测在设置侧的去处：LLM 请求日志、分类器日志。
 *
 * 「智能体」运行时面板已迁到主窗口右侧面板（RightPanel 的 agents tab）；这里是 httpLogs 与
 * classifierLogs（分类器调用日志，与分类场景无关）。
 * 子分类仍走**横向标签条**（PanelTabBar，与右侧面板外观一致）而非去掉外壳 ——
 * 后续新增观测页时直接往标签条里加。
 */
import { useTranslation } from 'react-i18next'
import { FileText, ScanSearch } from 'lucide-react'
import { PanelTabBar } from '@shuvix/app-shell'
import { HttpLogSettings } from './HttpLogSettings'
import { ClassifierLogSettings } from './ClassifierLogSettings'

export type MonitorSubTab = 'httpLogs' | 'classifierLogs'

/** 合法子 tab（供 hash 路由 `#settings/monitor/<sub>` 校验；旧的 agents 自然回落到默认） */
export const MONITOR_SUB_TABS = new Set<string>(['httpLogs', 'classifierLogs'])

export function MonitorSettings({
  subTab,
  onSubTabChange
}: {
  subTab: MonitorSubTab
  onSubTabChange: (sub: MonitorSubTab) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelTabBar
        tabs={[
          { key: 'httpLogs', label: t('settings.monitorSubTabLlm'), Icon: FileText },
          { key: 'classifierLogs', label: t('settings.monitorSubTabClassifier'), Icon: ScanSearch }
        ]}
        activeKey={subTab}
        onSelect={(key) => onSubTabChange(key as MonitorSubTab)}
        className="px-1 bg-bg-primary"
      />

      <div className="flex-1 min-h-0 flex flex-col">
        {subTab === 'classifierLogs' ? <ClassifierLogSettings /> : <HttpLogSettings />}
      </div>
    </div>
  )
}
