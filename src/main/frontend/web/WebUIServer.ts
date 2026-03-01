import * as http from 'node:http'
import * as os from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import { chatFrontendRegistry } from '../core'
import { webUIService } from '../../services/webUIService'
import { WebFrontend } from './WebFrontend'
import { createApiRouter } from './routes'
import { createLogger } from '../../logger'

const log = createLogger('WebUI:Server')

/** 默认端口 */
const DEFAULT_PORT = 39527

/**
 * WebUI HTTP + WebSocket 服务器
 * 在 Electron main process 中运行，提供 REST API 和实时事件推送
 */
class WebUIServer {
  private app = express()
  private httpServer: http.Server | null = null
  private wss: WebSocketServer | null = null
  private currentPort = DEFAULT_PORT

  /** 启动服务器 */
  start(port?: number): void {
    if (this.httpServer) return

    this.currentPort = port || DEFAULT_PORT

    // CORS
    this.app.use((_req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (_req.method === 'OPTIONS') {
        res.sendStatus(204)
        return
      }
      next()
    })

    // REST API
    this.app.use('/shuvix/api', createApiRouter())

    // 静态资源：WebUI 前端
    const webuiDistPath = this.resolveWebuiDist()
    if (webuiDistPath) {
      this.app.use('/shuvix', express.static(webuiDistPath))
      // SPA fallback — 所有 /shuvix/sessions/:id 都返回 index.html
      this.app.get('/shuvix/sessions/{*path}', (_req, res) => {
        res.sendFile(join(webuiDistPath, 'index.html'))
      })
    } else {
      // WebUI 前端未构建时，返回提示页面
      this.app.get('/shuvix/sessions/{*path}', (_req, res) => {
        res
          .status(503)
          .send(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>ShuviX WebUI</title>' +
              '<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;' +
              'height:100vh;margin:0;background:#0a0a0f;color:#a0a0b0;}' +
              '.box{text-align:center;max-width:400px;padding:2rem;}' +
              'h1{font-size:1.2rem;color:#e0e0f0;margin-bottom:0.5rem;}' +
              'p{font-size:0.85rem;line-height:1.6;}' +
              'code{background:#1a1a25;padding:2px 6px;border-radius:4px;font-size:0.8rem;}</style></head>' +
              '<body><div class="box"><h1>ShuviX WebUI</h1>' +
              '<p>WebUI 前端尚未构建。请运行 <code>npm run build:webui</code> 后重试。</p>' +
              '<p>The WebUI frontend has not been built yet. Run <code>npm run build:webui</code> and try again.</p>' +
              '</div></body></html>'
          )
      })
    }

    // HTTP Server
    this.httpServer = http.createServer(this.app)

    // WebSocket Server
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/shuvix/ws' })
    this.wss.on('connection', (socket, req) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      const sessionId = url.searchParams.get('sessionId')

      if (!sessionId || !webUIService.isShared(sessionId)) {
        socket.close(4003, 'Session not shared')
        return
      }

      log.info(`WebSocket 连接: session=${sessionId}`)
      const frontend = new WebFrontend(socket, sessionId)
      chatFrontendRegistry.bind(sessionId, frontend)

      socket.on('close', () => {
        chatFrontendRegistry.unbind(sessionId, frontend.id)
        log.info(`WebSocket 断开: session=${sessionId}, frontend=${frontend.id}`)
      })

      socket.on('error', (err) => {
        log.warn(`WebSocket 错误: ${err}`)
      })
    })

    this.httpServer.listen(this.currentPort, '0.0.0.0', () => {
      const urls = this.getAccessUrls()
      log.info(`WebUI 服务器已启动: port=${this.currentPort}`)
      urls.forEach((url) => log.info(`  → ${url}`))
    })

    this.httpServer.on('error', (err) => {
      log.error(`WebUI 服务器启动失败: ${err}`)
      this.httpServer = null
      this.wss = null
    })
  }

  /** 停止服务器 */
  stop(): void {
    if (this.wss) {
      this.wss.clients.forEach((client) => client.close(1001, 'Server shutting down'))
      this.wss.close()
      this.wss = null
    }
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }
    // 重置 Express app（路由不可清空，需新建）
    this.app = express()
    log.info('WebUI 服务器已停止')
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.httpServer !== null && this.httpServer.listening
  }

  /** 获取当前端口 */
  getPort(): number {
    return this.currentPort
  }

  /** 获取所有局域网访问地址 */
  getAccessUrls(): string[] {
    const urls: string[] = []
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const info of interfaces[name] || []) {
        if (info.family === 'IPv4' && !info.internal) {
          urls.push(`http://${info.address}:${this.currentPort}`)
        }
      }
    }
    if (urls.length === 0) {
      urls.push(`http://127.0.0.1:${this.currentPort}`)
    }
    return urls
  }

  /** 解析 WebUI 前端构建产物路径 */
  private resolveWebuiDist(): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs')
      // __dirname = out/main/（electron-vite 打包后的目录）
      // webui 构建产物在 out/webui/
      const distPath = join(__dirname, '../webui')
      if (fs.existsSync(join(distPath, 'index.html'))) {
        return distPath
      }
      log.warn('WebUI 前端资源未找到，仅提供 API 服务')
      return null
    } catch {
      return null
    }
  }
}

/** 全局单例 */
export const webUIServer = new WebUIServer()
// 注册到 webUIService，打破循环依赖
webUIService.registerServer(webUIServer)
