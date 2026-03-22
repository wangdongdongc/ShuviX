import { join, dirname } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { spawn } from 'child_process'
import { app, BrowserWindow } from 'electron'
import { getQwen3TtsDir } from '../../utils/paths'
import { listFiles } from '@huggingface/hub'
import { downloadManager } from '../downloadManager'
import { createLogger } from '../../logger'

const log = createLogger('Qwen3Model')

const MODEL_FOLDER = 'CustomVoice-1.7B'

/** HuggingFace 模型仓库 */
const HF_REPO = 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit'
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`
/** 通过 @huggingface/hub 获取仓库文件列表 */
async function fetchRepoFiles(): Promise<string[]> {
  const files: string[] = []
  for await (const entry of listFiles({ repo: HF_REPO })) {
    if (entry.type === 'file' && !entry.path.startsWith('.') && entry.path !== 'README.md') {
      files.push(entry.path)
    }
  }
  return files
}

/** standalone Python 下载地址（macOS aarch64） */
const PYTHON_URL =
  'https://github.com/indygreg/python-build-standalone/releases/download/20250604/cpython-3.12.11+20250604-aarch64-apple-darwin-install_only_stripped.tar.gz'
const PYTHON_ARCHIVE = 'cpython-3.12.tar.gz'

/** 语音列表 */
export interface Qwen3Voice {
  id: string
  name: string
  language: string
  gender: 'Male' | 'Female'
}

export const QWEN3_VOICES: Qwen3Voice[] = [
  { id: 'Vivian', name: 'Vivian', language: 'Chinese/English', gender: 'Female' },
  { id: 'Serena', name: 'Serena', language: 'Chinese/English', gender: 'Female' },
  { id: 'Chelsie', name: 'Chelsie', language: 'English', gender: 'Female' },
  { id: 'Ryan', name: 'Ryan', language: 'English', gender: 'Male' },
  { id: 'Aiden', name: 'Aiden', language: 'English', gender: 'Male' },
  { id: 'Dylan', name: 'Dylan', language: 'Chinese', gender: 'Male' },
  { id: 'Uncle_Fu', name: 'Uncle Fu', language: 'Chinese', gender: 'Male' }
]

export interface Qwen3TtsEnvironment {
  pythonBin: string
  cliScript: string
  modelsDir: string
}

export interface Qwen3TtsStatus {
  ready: boolean
  hasPython: boolean
  hasDeps: boolean
  hasModel: boolean
  modelSizeMB: number | null
  /** 当前平台是否支持 Qwen3-TTS（仅 macOS aarch64） */
  platformSupported: boolean
}

export interface Qwen3SetupProgress {
  step: 'python' | 'venv' | 'deps' | 'model'
  /** i18n key，由 renderer 翻译 */
  messageKey: string
  /** 0-100，-1 表示不确定 */
  percent: number
}

/** 计算目录总大小（MB） */
function dirSizeMB(dirPath: string): number | null {
  if (!existsSync(dirPath)) return null
  let total = 0
  const walk = (p: string): void => {
    for (const f of readdirSync(p, { withFileTypes: true })) {
      const fp = join(p, f.name)
      if (f.isDirectory()) walk(fp)
      else total += statSync(fp).size
    }
  }
  try {
    walk(dirPath)
    return Math.round(total / (1024 * 1024))
  } catch {
    return null
  }
}

/** 检查目录中是否存在权重文件 */
function hasWeightFiles(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    const walk = (p: string, depth: number): boolean => {
      if (depth > 3) return false
      for (const f of readdirSync(p, { withFileTypes: true })) {
        if (f.isDirectory()) {
          if (walk(join(p, f.name), depth + 1)) return true
        } else if (
          f.name.endsWith('.safetensors') ||
          f.name.endsWith('.npz') ||
          f.name.endsWith('.bin')
        ) {
          return true
        }
      }
      return false
    }
    return walk(dir, 0)
  } catch {
    return false
  }
}

class Qwen3ModelManager {
  private _aborted = false
  private _activeDownloadId: string | null = null
  /** 检查当前环境状态 */
  getStatus(): Qwen3TtsStatus {
    const platformSupported = process.platform === 'darwin' && process.arch === 'arm64'
    const base = getQwen3TtsDir()
    const pythonBin = join(base, 'python', 'bin', 'python3')
    const venvPython = join(base, '.venv', 'bin', 'python3')
    const modelsDir = join(base, 'models')

    const hasPython = existsSync(pythonBin)
    const hasDeps = existsSync(venvPython)
    const modelDir = join(modelsDir, MODEL_FOLDER)
    const hasModel = hasWeightFiles(modelDir)
    const modelSizeMB = existsSync(modelDir) ? dirSizeMB(modelDir) : null

    return {
      ready: platformSupported && hasPython && hasDeps && hasModel,
      hasPython,
      hasDeps,
      hasModel,
      modelSizeMB,
      platformSupported
    }
  }

  /** 获取可用环境路径，null 表示未就绪 */
  getEnvironment(): Qwen3TtsEnvironment | null {
    const status = this.getStatus()
    if (!status.ready) return null

    const base = getQwen3TtsDir()
    const cliScript = join(app.getAppPath(), 'resources', 'tts', 'tts_cli.py')

    return {
      pythonBin: join(base, '.venv', 'bin', 'python3'),
      cliScript,
      modelsDir: join(base, 'models')
    }
  }

  /** 返回可用语音列表 */
  listVoices(): Qwen3Voice[] {
    return QWEN3_VOICES
  }

  /** 完整安装流程 */
  async setup(onProgress: (p: Qwen3SetupProgress) => void): Promise<void> {
    this._aborted = false
    const base = getQwen3TtsDir()

    // Step 1: 下载 standalone Python
    const pythonDir = join(base, 'python')
    if (!existsSync(join(pythonDir, 'bin', 'python3'))) {
      onProgress({ step: 'python', messageKey: 'settings.voiceTtsQwen3StepPython', percent: -1 })
      await this.downloadPython(base)
    }
    this.checkAborted()
    onProgress({ step: 'python', messageKey: 'settings.voiceTtsQwen3StepPythonDone', percent: 100 })

    // Step 2: 创建 venv
    const venvDir = join(base, '.venv')
    if (!existsSync(join(venvDir, 'bin', 'python3'))) {
      onProgress({ step: 'venv', messageKey: 'settings.voiceTtsQwen3StepVenv', percent: -1 })
      await this.runCommand(join(pythonDir, 'bin', 'python3'), ['-m', 'venv', venvDir])
    }
    this.checkAborted()
    onProgress({ step: 'venv', messageKey: 'settings.voiceTtsQwen3StepVenvDone', percent: 100 })

    // Step 3: 安装依赖
    const venvPip = join(venvDir, 'bin', 'pip3')
    onProgress({ step: 'deps', messageKey: 'settings.voiceTtsQwen3StepDeps', percent: -1 })
    const requirementsPath = join(app.getAppPath(), 'resources', 'tts', 'requirements.txt')
    await this.runCommand(venvPip, ['install', '-r', requirementsPath])
    this.checkAborted()
    onProgress({ step: 'deps', messageKey: 'settings.voiceTtsQwen3StepDepsDone', percent: 100 })

    // Step 4: 下载模型（使用 downloadManager）
    onProgress({ step: 'model', messageKey: 'settings.voiceTtsQwen3StepModel', percent: 0 })
    await this.downloadModel(base)
    this.checkAborted()
    onProgress({ step: 'model', messageKey: 'settings.voiceTtsQwen3StepModelDone', percent: 100 })

    log.info('Qwen3-TTS setup complete')
  }

  /** 中止当前 setup 流程 */
  cancelSetup(): void {
    this._aborted = true
    // 取消正在进行的下载任务
    if (this._activeDownloadId) {
      downloadManager.cancel(this._activeDownloadId)
      this._activeDownloadId = null
    }
    log.info('Setup cancelled by user')
  }

  private checkAborted(): void {
    if (this._aborted) {
      throw new Error('Setup cancelled')
    }
  }

  /** 下载 standalone Python（使用 downloadManager + tar 解压） */
  private async downloadPython(baseDir: string): Promise<void> {
    const archivePath = join(baseDir, PYTHON_ARCHIVE)
    const pythonDir = join(baseDir, 'python')

    this._activeDownloadId = 'qwen3-python'
    await downloadManager.start({
      id: 'qwen3-python',
      url: PYTHON_URL,
      destPath: archivePath
    })
    this._activeDownloadId = null

    // 解压
    mkdirSync(pythonDir, { recursive: true })
    await this.runCommand('tar', ['-xzf', archivePath, '-C', pythonDir, '--strip-components=1'])

    try {
      unlinkSync(archivePath)
    } catch {
      /* ignore */
    }

    log.info('Standalone Python downloaded')
  }

  /** 下载模型（逐文件使用 downloadManager，进度通过 download:progress 广播） */
  private async downloadModel(baseDir: string): Promise<void> {
    const modelDir = join(baseDir, 'models', MODEL_FOLDER)
    mkdirSync(modelDir, { recursive: true })

    const files = await fetchRepoFiles()
    for (const file of files) {
      const destPath = join(modelDir, file)
      if (existsSync(destPath)) continue // 跳过已存在的文件（支持断点续传）

      // 确保子目录存在
      const dir = dirname(destPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const url = `${HF_BASE}/${file}`
      const taskId = `qwen3-model-${file.replace(/\//g, '-')}`
      log.info(`Downloading: ${file}`)

      this._activeDownloadId = taskId
      await downloadManager.start({ id: taskId, url, destPath })
      this._activeDownloadId = null
      this.checkAborted()
    }

    log.info('Model download complete')
  }

  /** 运行命令的通用封装 */
  private runCommand(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim()}`))
      })
      child.on('error', reject)
    })
  }

  /** 广播 setup 进度到所有渲染窗口 */
  broadcastProgress(progress: Qwen3SetupProgress): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('tts:setupProgress', progress)
    }
  }
}

export const qwen3ModelManager = new Qwen3ModelManager()
