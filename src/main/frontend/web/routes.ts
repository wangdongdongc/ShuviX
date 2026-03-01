import { Router, json } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { chatGateway } from '../core'
import { sessionService } from '../../services/sessionService'
import { providerService } from '../../services/providerService'
import { settingsService } from '../../services/settingsService'
import { webUIService } from '../../services/webUIService'
import { createLogger } from '../../logger'

const log = createLogger('WebUI:API')

/** 从路由参数中安全提取 sessionId */
function getSessionId(req: Request): string {
  const id = req.params.id
  return Array.isArray(id) ? id[0] : id
}

/** 校验 session 已开启分享 */
function shareGuard(req: Request, res: Response, next: NextFunction): void {
  const sessionId = getSessionId(req)
  if (!sessionId || !webUIService.isShared(sessionId)) {
    res.status(403).json({ error: 'Session not shared' })
    return
  }
  next()
}

/** 创建 WebUI REST API 路由 */
export function createApiRouter(): Router {
  const router = Router()
  router.use(json())

  // ─── Session 信息 ──────────────────────────────

  router.get('/sessions/:id', shareGuard, (req, res) => {
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

  // ─── 消息操作 ──────────────────────────────────

  router.get('/sessions/:id/messages', shareGuard, (req, res) => {
    try {
      res.json(chatGateway.listMessages(getSessionId(req)))
    } catch (e) {
      log.warn(`GET messages 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/sessions/:id/messages', shareGuard, (req, res) => {
    try {
      const msg = chatGateway.addMessage({ ...req.body, sessionId: getSessionId(req) })
      res.json(msg)
    } catch (e) {
      log.warn(`POST message 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/sessions/:id/messages/delete-from', shareGuard, (req, res) => {
    try {
      chatGateway.deleteFromMessage(getSessionId(req), req.body.messageId)
      res.json({ success: true })
    } catch (e) {
      log.warn(`DELETE message 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ─── Agent 操作 ────────────────────────────────

  router.post('/sessions/:id/init', shareGuard, (req, res) => {
    try {
      const result = chatGateway.initAgent(getSessionId(req))
      res.json(result)
    } catch (e) {
      log.warn(`POST init 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/sessions/:id/prompt', shareGuard, async (req, res) => {
    try {
      await chatGateway.prompt(getSessionId(req), req.body.text, req.body.images)
      res.json({ success: true })
    } catch (e) {
      log.warn(`POST prompt 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/sessions/:id/abort', shareGuard, (req, res) => {
    try {
      const result = chatGateway.abort(getSessionId(req))
      res.json(result)
    } catch (e) {
      log.warn(`POST abort 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ─── 交互响应 ──────────────────────────────────

  router.post('/sessions/:id/approve', shareGuard, (req, res) => {
    try {
      chatGateway.approveToolCall(req.body.toolCallId, req.body.approved, req.body.reason)
      res.json({ success: true })
    } catch (e) {
      log.warn(`POST approve 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/sessions/:id/respond-ask', shareGuard, (req, res) => {
    try {
      chatGateway.respondToAsk(req.body.toolCallId, req.body.selections)
      res.json({ success: true })
    } catch (e) {
      log.warn(`POST respond-ask 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/sessions/:id/respond-ssh', shareGuard, (req, res) => {
    try {
      chatGateway.respondToSshCredentials(req.body.toolCallId, req.body.credentials)
      res.json({ success: true })
    } catch (e) {
      log.warn(`POST respond-ssh 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ─── 运行时调整 ────────────────────────────────

  router.put('/sessions/:id/model', shareGuard, (req, res) => {
    try {
      chatGateway.setModel(
        getSessionId(req),
        req.body.provider,
        req.body.model,
        req.body.baseUrl,
        req.body.apiProtocol
      )
      // 同步更新 session 持久化
      sessionService.updateModelConfig(getSessionId(req), req.body.provider, req.body.model)
      res.json({ success: true })
    } catch (e) {
      log.warn(`PUT model 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.put('/sessions/:id/thinking', shareGuard, (req, res) => {
    try {
      chatGateway.setThinkingLevel(getSessionId(req), req.body.level)
      res.json({ success: true })
    } catch (e) {
      log.warn(`PUT thinking 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.put('/sessions/:id/tools', shareGuard, (req, res) => {
    try {
      chatGateway.setEnabledTools(getSessionId(req), req.body.tools)
      res.json({ success: true })
    } catch (e) {
      log.warn(`PUT tools 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.put('/sessions/:id/title', shareGuard, (req, res) => {
    try {
      sessionService.updateTitle(getSessionId(req), req.body.title)
      res.json({ success: true })
    } catch (e) {
      log.warn(`PUT title 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.put('/sessions/:id/settings', shareGuard, (req, res) => {
    try {
      sessionService.updateSettings(getSessionId(req), req.body.settings)
      res.json({ success: true })
    } catch (e) {
      log.warn(`PUT settings 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.put('/sessions/:id/model-metadata', shareGuard, (req, res) => {
    try {
      sessionService.updateModelMetadata(getSessionId(req), req.body.modelMetadata)
      res.json({ success: true })
    } catch (e) {
      log.warn(`PUT model-metadata 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ─── 资源操作 ──────────────────────────────────

  router.get('/sessions/:id/docker', shareGuard, (req, res) => {
    try {
      res.json(chatGateway.getDockerStatus(getSessionId(req)))
    } catch (e) {
      log.warn(`GET docker 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/sessions/:id/docker/destroy', shareGuard, async (req, res) => {
    try {
      const result = await chatGateway.destroyDocker(getSessionId(req))
      res.json(result)
    } catch (e) {
      log.warn(`POST docker/destroy 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.get('/sessions/:id/ssh', shareGuard, (req, res) => {
    try {
      res.json(chatGateway.getSshStatus(getSessionId(req)))
    } catch (e) {
      log.warn(`GET ssh 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/sessions/:id/ssh/disconnect', shareGuard, async (req, res) => {
    try {
      const result = await chatGateway.disconnectSsh(getSessionId(req))
      res.json(result)
    } catch (e) {
      log.warn(`POST ssh/disconnect 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ─── 工具 / 提供商 / 设置 ─────────────────────

  router.get('/tools', (_req, res) => {
    try {
      res.json(chatGateway.listTools())
    } catch (e) {
      log.warn(`GET tools 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.get('/providers', (_req, res) => {
    try {
      const providers = providerService.listEnabled()
      const models = providerService.listAvailableModels()
      res.json({ providers, models })
    } catch (e) {
      log.warn(`GET providers 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.get('/settings', (_req, res) => {
    try {
      const all = settingsService.getAll()
      res.json(all)
    } catch (e) {
      log.warn(`GET settings 失败: ${e}`)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  return router
}
