import { Router, json } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { chatGateway, operationContext, createWebUIContext } from '../core'
import { sessionService } from '../../services/sessionService'
import { providerService } from '../../services/providerService'
import { settingsService } from '../../services/settingsService'
import { webUIService } from '../../services/webUIService'
import { getBuiltinToolDefinitions } from '../../services/agentToolBuilder'
import { scanSessionFiles } from '../../services/filesWatcherService'
import { previewSessionFile } from '../../services/filePreviewService'
import { createLogger } from '../../logger'

const log = createLogger('WebUI:API')

/** 从路由参数中安全提取 sessionId */
function getSessionId(req: Request): string {
  const id = req.params.id
  return Array.isArray(id) ? id[0] : id
}

/** 校验 session 已开启分享（仅查看）；未分享一律拒绝 */
function shareGuard(req: Request, res: Response, next: NextFunction): void {
  const sessionId = getSessionId(req)
  if (!sessionId || !webUIService.isShared(sessionId)) {
    res.status(403).json({ error: 'Session not shared' })
    return
  }
  next()
}

/** 包裹路由 handler，自动注入 OperationContext */
function wrapRoute(
  handler: (req: Request, res: Response) => void | Promise<void>
): (req: Request, res: Response) => void {
  return (req, res) => {
    const sessionId = req.params.id ? getSessionId(req) : undefined
    const ctx = createWebUIContext(
      req.ip || req.socket.remoteAddress || 'unknown',
      'webui-http',
      sessionId,
      req.headers['user-agent']
    )
    operationContext.run(ctx, () => handler(req, res))
  }
}

/**
 * 创建 WebUI REST API 路由。
 *
 * 局域网分享一律「仅查看」：同网设备只能查看会话现存内容。故这里只暴露**只读 GET** 路由
 * （会话/消息/运行时/文件读取，供消息列表 + 笔记本只读预览渲染），不再有任何发送/编辑/销毁类写路由。
 */
export function createApiRouter(): Router {
  const router = Router()
  router.use(json())

  // ─── Session 信息（只读） ──────────────────────

  router.get(
    '/sessions/:id',
    shareGuard,
    wrapRoute((req, res) => {
      try {
        const session = sessionService.getById(getSessionId(req))
        if (!session) {
          res.status(404).json({ error: 'Session not found' })
          return
        }
        res.json(session)
      } catch (e) {
        log.warn(`GET /sessions/${getSessionId(req)} 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  // Design preview 状态（占位，只读）
  router.get(
    '/sessions/:id/design',
    shareGuard,
    wrapRoute((_req, res) => {
      res.json({ active: false, server: null })
    })
  )

  // ─── 消息（只读） ──────────────────────────────

  router.get(
    '/sessions/:id/messages',
    shareGuard,
    wrapRoute((req, res) => {
      try {
        res.json(chatGateway.listMessages(getSessionId(req)))
      } catch (e) {
        log.warn(`GET messages 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  // ─── 会话初始化（只读：返回会话元信息供渲染） ──

  router.post(
    '/sessions/:id/init',
    shareGuard,
    wrapRoute((req, res) => {
      try {
        const result = chatGateway.startChat(getSessionId(req))
        res.json(result)
      } catch (e) {
        log.warn(`POST init 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  // ─── 运行时资源（只读） ─────────────────────────

  router.get(
    '/sessions/:id/runtimes',
    shareGuard,
    wrapRoute((req, res) => {
      try {
        res.json(chatGateway.getRuntimeStatuses(getSessionId(req)))
      } catch (e) {
        log.warn(`GET runtimes 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  // ─── 工作目录文件（只读：扫描 + 预览，供笔记本只读预览读取内容） ──

  router.get(
    '/sessions/:id/files',
    shareGuard,
    wrapRoute(async (req, res) => {
      try {
        res.json(await scanSessionFiles(getSessionId(req)))
      } catch (e) {
        log.warn(`GET files 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  router.get(
    '/sessions/:id/files/read',
    shareGuard,
    wrapRoute(async (req, res) => {
      try {
        const path = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path
        res.json(await previewSessionFile(getSessionId(req), String(path ?? '')))
      } catch (e) {
        log.warn(`GET files/read 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  // ─── 工具 / 提供商 / 设置（全局只读） ──────────

  router.get(
    '/tools',
    wrapRoute((_req, res) => {
      try {
        res.json(chatGateway.listTools())
      } catch (e) {
        log.warn(`GET tools 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  router.get(
    '/tools/definitions',
    wrapRoute((_req, res) => {
      try {
        res.json(getBuiltinToolDefinitions())
      } catch (e) {
        log.warn(`GET tools/definitions 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  router.get(
    '/providers',
    wrapRoute((_req, res) => {
      try {
        const providers = providerService.listEnabled()
        const models = providerService.listAvailableModels()
        res.json({ providers, models })
      } catch (e) {
        log.warn(`GET providers 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  router.get(
    '/settings',
    wrapRoute((_req, res) => {
      try {
        const all = settingsService.getAll()
        res.json(all)
      } catch (e) {
        log.warn(`GET settings 失败: ${e}`)
        res.status(500).json({ error: 'Internal error' })
      }
    })
  )

  return router
}
