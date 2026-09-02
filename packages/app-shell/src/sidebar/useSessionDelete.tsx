/**
 * useSessionDelete —— 会话删除全流程（桌面/扩展单一来源）。
 *
 * 流程：检查消息数与子会话数 → 任一非空则弹「共享 ConfirmDialog」确认 → 删库 + 从
 * chatStore 移除（子会话随父级级联删除，所以一并移除，免得留下指向已删行的 active）。
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

  /** 该会话的子会话（后端删父时级联删子；这里只做前端侧的同步移除与文案计数） */
  const childrenOf = (id: string): string[] =>
    useChatStore
      .getState()
      .sessions.filter((s) => s.parentId === id)
      .map((s) => s.id)

  const doDelete = useCallback(async (id: string) => {
    const children = childrenOf(id)
    await getChatApi().session.delete(id)
    // removeSession 在删的是当前激活会话时会自动清空 active —— 子会话也要过一遍，
    // 否则激活的是被级联删掉的子会话时，界面会停在一条已经不存在的会话上
    for (const childId of children) useChatStore.getState().removeSession(childId)
    useChatStore.getState().removeSession(id)
  }, [])

  const requestDelete = useCallback(
    async (id: string) => {
      const msgs = await getChatApi().message.list(id)
      // 有子会话必须确认，哪怕父会话本身是空的：级联删掉的是别的对话
      if (msgs.length > 0 || childrenOf(id).length > 0) {
        setPendingId(id)
        return
      }
      await doDelete(id)
    },
    [doDelete]
  )

  const pendingChildren = pendingId ? childrenOf(pendingId).length : 0
  const deleteDialog = pendingId ? (
    <ConfirmDialog
      title={t('sidebar.confirmDelete')}
      description={
        <>
          {t('sidebar.deleteWarning')}
          <span className="text-error font-medium">{t('sidebar.deleteWarningBold')}</span>
          {t('sidebar.deleteWarningEnd')}
          {pendingChildren > 0 && (
            <>
              {' '}
              <span className="text-error font-medium">
                {t('sidebar.deleteSubSessionsWarning', { count: pendingChildren })}
              </span>
            </>
          )}
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
