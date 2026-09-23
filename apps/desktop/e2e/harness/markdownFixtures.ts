/**
 * 从系统打开 md 这一区（`e2e/specs/markdown/`）的共用夹具。
 *
 * 两件事：
 *   - **用户自己的目录**：md 文件所在的目录就是会话的工作目录，它不该在 fake HOME 里（HOME 是
 *     「应用的地盘」，而这里要证的恰恰是「应用不动用户的目录」），所以另起一个临时目录，取 realpath
 *     （macOS 的 /tmp、/var 都是链接，主进程按真实路径开窗，断言也得按真实路径比）；
 *   - **先种模型再带着 md 启动**：md 窗口的渲染端只在启动时读一次提供商 / 模型（没选中模型时输入卡片
 *     发不出去），而带着 md 启动时没有主窗口可以先去种 —— 所以先普通启动一次、种好假提供商、
 *     `stop({ keepHome: true })`，再用同一个 HOME 带着 md 参数起第二次。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launchApp, type E2EMarkdownApp, type MarkdownLaunchOptions } from './launch'
import { seedFakeProvider } from './seed'
import { startFakeProvider, type FakeProvider } from './fakeProvider'

/** 假提供商的模型 id（与 seedFakeProvider 一起写进默认模型） */
export const MD_FAKE_MODEL = 'e2e-md-model'

export interface UserDir {
  /** 目录的真实路径 */
  root: string
  /** 在目录里写一份文件（中间目录自动建），回它的绝对路径 */
  file(rel: string, content: string): string
  /** 建一个符号链接 `rel` → `target`（target 为绝对路径），回链接的绝对路径 */
  link(rel: string, target: string): string
  /** 建一个目录，回它的绝对路径 */
  dir(rel: string): string
  /** 删掉整个目录（afterAll） */
  remove(): void
}

/** 一个「用户自己的」临时目录（不在 fake HOME 里） */
export function userDir(prefix = 'shuvix-md-user-'): UserDir {
  const root = realpathSync(mkdtempSync(join('/private/tmp', prefix)))
  return {
    root,
    file(rel, content) {
      const path = join(root, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return path
    },
    link(rel, target) {
      const path = join(root, rel)
      mkdirSync(dirname(path), { recursive: true })
      symlinkSync(target, path)
      return path
    },
    dir(rel) {
      const path = join(root, rel)
      mkdirSync(path, { recursive: true })
      return path
    },
    remove() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/**
 * 起一个假提供商、把它种成默认模型，再带着 md 参数（不等主窗口）启动。
 * 返回的实例用完照常 `stop()`；假提供商由调用方 `close()`。
 */
export async function launchMarkdownWithProvider(
  opts: Omit<MarkdownLaunchOptions, 'expectMainWindow' | 'home'>
): Promise<{ app: E2EMarkdownApp; provider: FakeProvider }> {
  const provider = await startFakeProvider()
  const seeding = await launchApp()
  try {
    await seedFakeProvider(seeding.main, { baseUrl: provider.baseUrl, modelId: MD_FAKE_MODEL })
  } catch (err) {
    await seeding.stop()
    await provider.close()
    throw err
  }
  await seeding.stop({ keepHome: true })
  try {
    const app = await launchApp({ ...opts, home: seeding.home, expectMainWindow: false })
    return { app, provider }
  } catch (err) {
    rmSync(seeding.home, { recursive: true, force: true })
    await provider.close()
    throw err
  }
}

/** 主进程日志里某个标记出现的行（按写入顺序） */
export function logLines(log: string, marker: string): string[] {
  return log.split('\n').filter((l) => l.includes(marker))
}
