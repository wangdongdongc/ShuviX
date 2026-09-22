/**
 * 这个扩展是谁、这是浏览器的哪一轮运行 —— 握手时告诉桌面。
 *
 *  - installId（chrome.storage.local）：一个浏览器 profile 一个，跨浏览器重启不变。桌面据此区分
 *    多个浏览器 / profile，标签页会话也记在它名下。
 *  - runId（chrome.storage.session）：浏览器重启即换（session 存储只活在这一轮运行里，SW 重启不丢）。
 *    标签页 id 只在一轮运行内有意义，桌面据此清掉上一轮留下的会话。
 */

let installIdPromise: Promise<string> | null = null
let runIdPromise: Promise<string> | null = null

async function readOrCreate(area: chrome.storage.StorageArea, key: string): Promise<string> {
  const got = await area.get(key)
  const existing = got[key]
  if (typeof existing === 'string' && existing) return existing
  const id = crypto.randomUUID()
  await area.set({ [key]: id })
  return id
}

export function getInstallId(): Promise<string> {
  installIdPromise ??= readOrCreate(chrome.storage.local, 'installId')
  return installIdPromise
}

export function getRunId(): Promise<string> {
  runIdPromise ??= readOrCreate(chrome.storage.session, 'runId')
  return runIdPromise
}

interface UADataBrand {
  brand: string
  version: string
}

/** 浏览器名与大版本（只作展示）：Chrome / Edge / Brave … 优先于泛称 Chromium */
export function browserLabel(): string {
  const data = (navigator as Navigator & { userAgentData?: { brands?: UADataBrand[] } })
    .userAgentData
  const brands = (data?.brands ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand))
  const pick = brands.find((b) => b.brand !== 'Chromium') ?? brands[0]
  return pick ? `${pick.brand} ${pick.version}` : 'Chrome'
}
