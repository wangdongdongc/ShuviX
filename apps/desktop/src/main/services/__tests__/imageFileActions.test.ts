/**
 * imageFileActions —— 看图层在桌面上的「复制」与「下载」（主进程读文件：页面拿不到 `shuvix-preview://` 的字节）。
 *
 *   IFA-1 copyImageFile：解析出路径、系统解得了 → true，writeImage 那张图（createFromBuffer 收到文件的字节）；
 *         解不了（isEmpty）→ false、不写剪贴板；文件不在 → false + warn；解析不出（null）→ false、不读文件
 *   IFA-2 saveNameOf：非法字符 / 控制字符换成 `_`；空白、空串、undefined、全是点 → 兜底名
 *   IFA-3 saveImageFile：解析不出 → 'failed' 不弹框；源文件不在（含回收站的库文件解成 `.missing`）→ 'failed' 不弹框；
 *         有发起窗口 → showSaveDialog(win, {defaultPath: <下载目录>/<saveNameOf(name, 源文件名)>})；没有 → 单参数形式；
 *         取消或空路径 → 'cancelled'、不复制；选了位置 → 字节复制过去、'saved'
 *
 * electron 全是假的；resolveOpenTarget 是间谍（解析本身见 previewWindowService 的 RO-1）；文件是真的（临时目录）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fx = vi.hoisted(() => {
  const image = { isEmpty: vi.fn(() => false) }
  return {
    image,
    createFromBuffer: vi.fn((_buf: Buffer) => image),
    writeImage: vi.fn(),
    showSaveDialog: vi.fn(),
    downloads: '',
    fromWebContents: vi.fn(),
    resolveOpenTarget: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: fx.fromWebContents },
  app: { getPath: (name: string) => (name === 'downloads' ? fx.downloads : '/nowhere') },
  clipboard: { writeImage: fx.writeImage },
  dialog: { showSaveDialog: fx.showSaveDialog },
  nativeImage: { createFromBuffer: fx.createFromBuffer }
}))
vi.mock('../previewWindowService', () => ({ resolveOpenTarget: fx.resolveOpenTarget }))
vi.mock('../../logger', () => ({ createLogger: () => fx.log }))

import { copyImageFile, saveImageFile, saveNameOf } from '../imageFileActions'

const root = mkdtempSync(join(tmpdir(), 'shuvix-imgactions-'))
const src = join(root, 'pic.png')
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const PARAMS = { sessionId: 's1', path: '/a/pic.png', name: 'Pretty.png' }

beforeAll(() => {
  writeFileSync(src, BYTES)
  fx.downloads = join(root, 'Downloads')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  fx.image.isEmpty.mockReturnValue(false)
  fx.resolveOpenTarget.mockReturnValue({ absolute: src, library: false })
})

describe('IFA-1 copyImageFile', () => {
  it('解得了 → true，剪贴板写那张图，createFromBuffer 收到文件的字节', async () => {
    expect(await copyImageFile(PARAMS)).toBe(true)
    expect(fx.resolveOpenTarget).toHaveBeenCalledWith(PARAMS)
    expect(fx.createFromBuffer).toHaveBeenCalledTimes(1)
    expect(Buffer.compare(fx.createFromBuffer.mock.calls[0][0], BYTES)).toBe(0)
    expect(fx.writeImage).toHaveBeenCalledWith(fx.image)
  })

  it('isEmpty → false，不写剪贴板', async () => {
    fx.image.isEmpty.mockReturnValue(true)
    expect(await copyImageFile(PARAMS)).toBe(false)
    expect(fx.writeImage).not.toHaveBeenCalled()
  })

  it('文件不在 → false + warn', async () => {
    fx.resolveOpenTarget.mockReturnValue({ absolute: join(root, 'gone.png'), library: false })
    expect(await copyImageFile(PARAMS)).toBe(false)
    expect(fx.writeImage).not.toHaveBeenCalled()
    expect(fx.createFromBuffer).not.toHaveBeenCalled()
    expect(fx.log.warn).toHaveBeenCalledTimes(1)
  })

  it('解析不出 → false，不读文件', async () => {
    fx.resolveOpenTarget.mockReturnValue(null)
    expect(await copyImageFile(PARAMS)).toBe(false)
    expect(fx.createFromBuffer).not.toHaveBeenCalled()
    expect(fx.writeImage).not.toHaveBeenCalled()
  })
})

describe('IFA-2 saveNameOf', () => {
  it('非法字符换成 _（路径分隔符也是）', () => {
    expect(saveNameOf('a/b:c*?.png', 'fb.png')).toBe('a_b_c__.png')
    expect(saveNameOf('x\\y"<>|.png', 'fb.png')).toBe('x_y____.png')
  })

  it('控制字符换成 _', () => {
    expect(saveNameOf('a\u0001b\nc\u001f.png', 'fb.png')).toBe('a_b_c_.png')
  })

  it.each([['  '], [''], [undefined], ['..'], ['...'], ['.']])('%j → 兜底名', (name) => {
    expect(saveNameOf(name, 'fb.png')).toBe('fb.png')
  })

  it('普通名字原样（去掉首尾空白）', () => {
    expect(saveNameOf('  cat.png ', 'fb.png')).toBe('cat.png')
    expect(saveNameOf('.hidden.png', 'fb.png')).toBe('.hidden.png')
  })
})

describe('IFA-3 saveImageFile', () => {
  it('解析不出 → failed，不弹框', async () => {
    fx.resolveOpenTarget.mockReturnValue(null)
    expect(await saveImageFile(PARAMS)).toBe('failed')
    expect(fx.showSaveDialog).not.toHaveBeenCalled()
  })

  it('源文件不在（回收站的库文件解成 .missing）→ failed，不弹框', async () => {
    fx.resolveOpenTarget.mockReturnValue({
      absolute: join(root, '.shuvix', 'library', 'files', '.missing'),
      library: true
    })
    expect(await saveImageFile(PARAMS)).toBe('failed')
    fx.resolveOpenTarget.mockReturnValue({ absolute: join(root, 'gone.png'), library: false })
    expect(await saveImageFile(PARAMS)).toBe('failed')
    expect(fx.showSaveDialog).not.toHaveBeenCalled()
  })

  it('有发起窗口 → 挂在它上面，默认位置 = 下载目录 / 清洗过的名字', async () => {
    const win = { id: 7 }
    const sender = { id: 3 }
    fx.fromWebContents.mockReturnValue(win)
    fx.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' })
    expect(await saveImageFile({ ...PARAMS, name: 'my:pic.png' }, sender as never)).toBe(
      'cancelled'
    )
    expect(fx.fromWebContents).toHaveBeenCalledWith(sender)
    expect(fx.showSaveDialog.mock.calls).toEqual([
      [win, { defaultPath: join(fx.downloads, saveNameOf('my:pic.png', 'pic.png')) }]
    ])
    expect(fx.showSaveDialog.mock.calls[0][1].defaultPath).toBe(join(fx.downloads, 'my_pic.png'))
  })

  it('没有名字 → 用源文件名；没有发起窗口 → 单参数形式', async () => {
    fx.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await saveImageFile({ sessionId: 's1', path: '/a/pic.png' })).toBe('cancelled')
    expect(fx.fromWebContents).not.toHaveBeenCalled()
    expect(fx.showSaveDialog.mock.calls).toEqual([[{ defaultPath: join(fx.downloads, 'pic.png') }]])
  })

  it('取消 / 空路径 → cancelled，不复制', async () => {
    const dest = join(root, 'never.png')
    fx.showSaveDialog.mockResolvedValue({ canceled: true, filePath: dest })
    expect(await saveImageFile(PARAMS)).toBe('cancelled')
    fx.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '' })
    expect(await saveImageFile(PARAMS)).toBe('cancelled')
    expect(existsSync(dest)).toBe(false)
  })

  it('选了位置 → 字节复制过去，saved', async () => {
    const dest = join(root, 'saved.png')
    fx.showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest })
    expect(await saveImageFile(PARAMS)).toBe('saved')
    expect(Buffer.compare(readFileSync(dest), BYTES)).toBe(0)
  })

  it('复制失败（目标目录不在）→ failed + warn', async () => {
    fx.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(root, 'no-such-dir', 'x.png')
    })
    expect(await saveImageFile(PARAMS)).toBe('failed')
    expect(fx.log.warn).toHaveBeenCalledTimes(1)
  })
})
