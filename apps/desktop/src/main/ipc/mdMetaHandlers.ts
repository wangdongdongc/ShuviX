import { defineHandler } from './registry'
import { noteView, setEnabled, setNoteFill, unsetNoteFill } from '../services/mdMetaService'

/**
 * md 扩展元数据 IPC —— 属性卡「ShuviX 设置」条读写一份注册表笔记的补缺值（ChatApi `mdMeta`）。
 * 按笔记本会话认文件，校验全在 mdMetaService；这是补缺值唯一的写入口（不给工具、不给 CLI）。
 */
export function registerMdMetaHandlers(): void {
  defineHandler('mdMeta:get', (_ctx, params: { sessionId: string }) => noteView(params?.sessionId))
  defineHandler(
    'mdMeta:setFill',
    (_ctx, params: { sessionId: string; objectId: string; key: string; value: unknown }) =>
      setNoteFill(params)
  )
  defineHandler('mdMeta:setEnabled', (_ctx, params: { objectId: string; enabled: boolean }) =>
    setEnabled(params)
  )
  defineHandler(
    'mdMeta:unsetFill',
    (_ctx, params: { sessionId: string; objectId: string; key: string }) => unsetNoteFill(params)
  )
}
