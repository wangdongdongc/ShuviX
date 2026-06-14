import { spawn } from 'child_process'
import type { TtsBackendMain, TtsSynthesizeParams } from './types'
import { settingsDao } from '../../dao/settingsDao'
import { qwen3ModelManager } from './qwen3ModelManager'
import { createLogger } from '../../logger'

const log = createLogger('Qwen3Tts')

/** 将 spawn 调用封装为 Promise */
function spawnPython(bin: string, script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`tts_cli.py exited with code ${code}: ${stderr.trim()}`))
      }
    })

    child.on('error', (err) => reject(err))
  })
}

/**
 * Qwen3-TTS 本地后端 — 通过 Python CLI 调用 mlx-audio 进行推理
 * 仅 macOS (Apple Silicon) 可用
 */
export class Qwen3TtsBackend implements TtsBackendMain {
  readonly outputExtension = 'wav'

  async synthesize(params: TtsSynthesizeParams): Promise<void> {
    const env = qwen3ModelManager.getEnvironment()
    if (!env) {
      throw new Error('本地 TTS 未就绪，请先在设置中完成安装')
    }

    const voice = settingsDao.findByKey('voice.tts.qwen3.voice') || 'Vivian'
    const speed = Number(settingsDao.findByKey('voice.tts.qwen3.speed')) || 1.0
    const emotion = settingsDao.findByKey('voice.tts.qwen3.emotion') || ''

    const text = params.text.slice(0, 4000)
    if (!text.trim()) {
      throw new Error('文本内容为空')
    }

    log.info(`Synthesizing (${text.length} chars, voice=${voice}, speed=${speed})`)

    await spawnPython(env.pythonBin, env.cliScript, [
      '--text',
      text,
      '--output',
      params.outputPath,
      '--voice',
      voice,
      '--speed',
      String(speed),
      ...(emotion ? ['--emotion', emotion] : []),
      '--models-dir',
      env.modelsDir
    ])

    log.info(`TTS audio saved to ${params.outputPath}`)
  }
}
