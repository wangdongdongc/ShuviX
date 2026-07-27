/**
 * WikiView — 侧栏 Wiki 视图:隐藏 wiki 项目(Wiki Curator 产物目录)的 markdown 文件树。
 * prop 驱动、不触宿主 API:文件清单与点击行为由宿主注入
 * (桌面端注入 window.api.wiki.listFiles / openNote,点击 md 打开或复用其笔记本会话)。
 * 刷新策略与 FilesPanel 一致:挂载扫描 + 窗口聚焦重扫,并带 stale-guard 防止乱序回包。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { FilesTree } from '../files/FilesTree'

export interface WikiViewProps {
  /** 拉取 wiki 根下全部 md 相对路径(宿主注入,须为稳定引用避免重复扫描) */
  listFiles: () => Promise<{ paths: string[]; truncated: boolean; root: string }>
  /** 点击 md 文件(相对路径);宿主负责打开/复用笔记本会话 */
  onSelectFile: (relPath: string) => void | Promise<void>
}

export function WikiView({ listFiles, onSelectFile }: WikiViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const [paths, setPaths] = useState<string[] | null>(null)
  // 递增序号丢弃过期回包(快速聚焦/手动刷新并发时只认最后一次)
  const scanSeq = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    const seq = ++scanSeq.current
    try {
      const r = await listFiles()
      if (seq === scanSeq.current) setPaths(r.paths)
    } catch {
      if (seq === scanSeq.current) setPaths([])
    }
  }, [listFiles])

  useEffect(() => {
    void scan() // eslint-disable-line react-hooks/set-state-in-effect
    const onFocus = (): void => void scan()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-end px-2 pb-1">
        <button
          onClick={() => void scan()}
          title={t('panel.filesRefresh')}
          className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        {paths &&
          (paths.length === 0 ? (
            <div className="px-3 py-6 text-center text-text-tertiary text-xs">
              {t('sidebar.wikiEmpty')}
            </div>
          ) : (
            <FilesTree paths={paths} searchQuery="" onFileSelect={(p) => void onSelectFile(p)} />
          ))}
      </div>
    </div>
  )
}
