/**
 * useSessionDelete —— 会话删除全流程（桌面/扩展单一来源）。
 *
 * 流程：检查消息数 → 含消息则弹「共享 ConfirmDialog」确认 → 删库 + 从 chatStore 移除。
 * 唯一随宿主而异的只有「检查 / 删除」两个调用，且它们已统一在注入式 ChatApi 之后
 * （getChatApi().message.list / session.delete）——其余（确认弹窗、文案、移除逻辑）全共用。
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getChatApi, useChatStore } from '@shuvix/chat-ui'
import { ConfirmDialog } from '../common/ConfirmDialog'

export interface UseSessionDeleteReturn {
  /** 请求删除会话（空会话直接删；含消息则弹确认框） */
  requestDelete: (id: string) => Promise<void>
  /** 待渲染的确认框（挂在宿主组件树中即可） */
  deleteDialog: React.ReactNode
}

export function useSessionDelete(): UseSessionDeleteReturn {
  const { t } = useTranslation()
  const [pendingId, setPendingId] = useState<string | null>(null)

  const doDelete = useCallback(async (id: string) => {
    await getChatApi().session.delete(id)
    // removeSession 在删的是当前激活会话时会自动清空 active
    useChatStore.getState().removeSession(id)
  }, [])

  const requestDelete = useCallback(
    async (id: string) => {
      const msgs = await getChatApi().message.list(id)
      if (msgs.length > 0) {
        setPendingId(id)
        return
      }
      await doDelete(id)
    },
    [doDelete]
  )

  const deleteDialog = pendingId ? (
    <ConfirmDialog
      title={t('sidebar.confirmDelete')}
      description={
        <>
          {t('sidebar.deleteWarning')}
          <span className="text-error font-medium">{t('sidebar.deleteWarningBold')}</span>
          {t('sidebar.deleteWarningEnd')}
        </>
      }
      confirmText={t('common.delete')}
      cancelText={t('common.cancel')}
      onConfirm={() => {
        const id = pendingId
        setPendingId(null)
        void doDelete(id)
      }}
      onCancel={() => setPendingId(null)}
    />
  ) : null

  return { requestDelete, deleteDialog }
}
