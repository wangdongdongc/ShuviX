/**
 * SSH 连接管理器
 * 管理 per-session 的 SSH 连接生命周期
 * 连接在用户提供凭据后建立，空闲超时后自动断开
 * 凭据仅存内存，不持久化
 */

import { Client, type ConnectConfig } from 'ssh2'
import { createLogger } from '../logger'
const log = createLogger('SSH')

/** 空闲超时时间（毫秒），超过此时间无命令执行则自动断开 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟

/** SSH 连接信息 */
interface SshConnectionInfo {
  client: Client
  host: string
  port: number
  username: string
  /** 空闲超时断开定时器 */
  destroyTimer?: ReturnType<typeof setTimeout>
}

/** SSH 连接凭据（仅在内存中传递，不持久化） */
export interface SshCredentials {
  host: string
  port: number
  username: string
  /** 密码认证 */
  password?: string
  /** 私钥认证：私钥内容（PEM 格式） */
  privateKey?: string
  /** 私钥口令（如果私钥有加密） */
  passphrase?: string
}

export class SshManager {
  /** sessionId → SSH 连接信息 */
  private connections = new Map<string, SshConnectionInfo>()

  /** 建立 SSH 连接 */
  async connect(sessionId: string, credentials: SshCredentials): Promise<{ success: boolean; error?: string }> {
    // 已有连接则先断开
    await this.disconnect(sessionId)

    const { host, port, username, password, privateKey, passphrase } = credentials

    return new Promise((resolve) => {
      const client = new Client()
      let settled = false

      // 连接超时
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          client.end()
          resolve({ success: false, error: `Connection timed out (${host}:${port})` })
        }
      }, 15000)

      client.on('ready', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.connections.set(sessionId, { client, host, port, username })

        // 监听连接断开事件，自动清理过期的连接记录
        const onDisconnect = (): void => {
          // 确保当前连接未被新连接替换（防止 race condition）
          if (this.connections.get(sessionId)?.client === client) {
            this.cancelScheduledDestroy(sessionId)
            this.connections.delete(sessionId)
            log.info(`SSH 连接已断开（远端关闭）session=${sessionId}`)
          }
        }
        client.on('close', onDisconnect)
        client.on('end', onDisconnect)
        client.on('error', (err) => {
          log.error(`SSH 连接异常 session=${sessionId}: ${err.message}`)
          onDisconnect()
        })

        const authMethod = privateKey ? 'key' : 'password'
        log.info(`SSH 连接成功 (${authMethod}) ${username}@${host}:${port} session=${sessionId}`)
        resolve({ success: true })
      })

      client.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        log.error(`SSH 连接失败 ${host}:${port}: ${err.message}`)
        resolve({ success: false, error: err.message })
      })

      // 根据凭据类型选择认证方式
      const connectConfig: ConnectConfig = {
        host,
        port,
        username,
        // 跳过 host key 验证（用户已确认连接意图）
        hostVerifier: () => true,
        readyTimeout: 15000,
        // 心跳保活：每 30 秒发送一次，连续 3 次无响应则断开
        // 防止 NAT/防火墙因空闲超时丢弃连接
        keepaliveInterval: 30000,
        keepaliveCountMax: 3
      }
      if (privateKey) {
        connectConfig.privateKey = privateKey
        if (passphrase) connectConfig.passphrase = passphrase
      } else if (password) {
        connectConfig.password = password
      }

      client.connect(connectConfig)
    })
  }

  /** 在远程服务器上执行命令 */
  async exec(
    sessionId: string,
    command: string,
    timeout: number = 120,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const conn = this.connections.get(sessionId)
    if (!conn) {
      throw new Error('No active SSH connection. Use ssh({ action: "connect" }) first.')
    }

    // 取消空闲定时器（有新命令到来）
    this.cancelScheduledDestroy(sessionId)

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'))
        return
      }

      let stdout = ''
      let stderr = ''
      let killed = false

      // 超时处理
      const timer = setTimeout(() => {
        killed = true
        // ssh2 没有直接 kill stream 的方法，通过发送 signal
        try { conn.client.end() } catch { /* 忽略 */ }
        resolve({ stdout, stderr, exitCode: 124 })
      }, timeout * 1000)

      // abort 处理
      const onAbort = (): void => {
        killed = true
        clearTimeout(timer)
        try { conn.client.end() } catch { /* 忽略 */ }
        reject(new Error('Aborted'))
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      conn.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
          reject(new Error(`SSH exec failed: ${err.message}`))
          return
        }

        stream.on('data', (data: Buffer) => {
          stdout += data.toString('utf-8')
        })

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf-8')
        })

        stream.on('close', (code: number | null) => {
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
          if (killed && signal?.aborted) {
            reject(new Error('Aborted'))
            return
          }
          resolve({
            stdout,
            stderr,
            exitCode: killed ? 124 : (code ?? 1)
          })
        })
      })
    })
  }

  /** 获取当前连接信息（不含敏感数据） */
  getConnectionInfo(sessionId: string): { host: string; port: number; username: string } | null {
    const conn = this.connections.get(sessionId)
    if (!conn) return null
    return { host: conn.host, port: conn.port, username: conn.username }
  }

  /** 检查是否有活跃连接 */
  isConnected(sessionId: string): boolean {
    return this.connections.has(sessionId)
  }

  /** 延迟断开连接（空闲超时） */
  scheduleDestroy(sessionId: string): void {
    const conn = this.connections.get(sessionId)
    if (!conn) return
    this.cancelScheduledDestroy(sessionId)
    log.info(`SSH 连接将在 ${IDLE_TIMEOUT_MS / 1000}s 空闲后断开 session=${sessionId}`)
    conn.destroyTimer = setTimeout(() => {
      conn.destroyTimer = undefined
      this.disconnect(sessionId)
    }, IDLE_TIMEOUT_MS)
  }

  /** 取消延迟断开定时器 */
  private cancelScheduledDestroy(sessionId: string): void {
    const conn = this.connections.get(sessionId)
    if (conn?.destroyTimer) {
      clearTimeout(conn.destroyTimer)
      conn.destroyTimer = undefined
    }
  }

  /** 断开指定 session 的 SSH 连接 */
  async disconnect(sessionId: string): Promise<void> {
    this.cancelScheduledDestroy(sessionId)
    const conn = this.connections.get(sessionId)
    if (!conn) return
    this.connections.delete(sessionId)
    try {
      conn.client.end()
    } catch {
      // 忽略断开错误
    }
    log.info(`SSH 连接已断开 session=${sessionId}`)
  }

  /** 断开所有连接（应用退出时调用） */
  async disconnectAll(): Promise<void> {
    const entries = Array.from(this.connections.keys())
    for (const sessionId of entries) {
      await this.disconnect(sessionId)
    }
  }
}

// 全局单例
export const sshManager = new SshManager()
