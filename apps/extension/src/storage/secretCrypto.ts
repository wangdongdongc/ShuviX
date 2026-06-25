/**
 * 扩展密钥的「落盘混淆」—— WebCrypto AES-256-GCM 加密 apiKey 后再写 chrome.storage.local。
 *
 * ⚠️ 安全性说明：与桌面 utils/crypto.ts 同级别 —— 桌面把随机 AES 密钥存在 DB 旁的 0600 文件里，
 * 这里把随机 AES 密钥存在同一 chrome.storage 里。**这是混淆，不是真正的静态加密**：能读到
 * storage 的代码同样能拿到密钥解密。它只防「随手 dump storage 肉眼看明文 / 截图」，达到与桌面
 * 大致相当的水准。真正的静态安全需用户口令派生密钥（never stored），属后续可选加固。
 */
const KEY_SLOT = '__shuvix_enc_key'
const PREFIX = '$SHUVIX_ENC$v1$'

let cachedKey: CryptoKey | null = null

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 取（或惰性生成并落盘）AES 密钥 */
async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey
  const stored = (await chrome.storage.local.get(KEY_SLOT))[KEY_SLOT] as string | undefined
  if (stored) {
    cachedKey = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(stored) as BufferSource,
      'AES-GCM',
      false,
      ['encrypt', 'decrypt']
    )
    return cachedKey
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt'
  ])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  await chrome.storage.local.set({ [KEY_SLOT]: bytesToBase64(raw) })
  cachedKey = key
  return key
}

/** 加密；空值/已加密原样返回 */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.startsWith(PREFIX)) return plaintext
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext) as BufferSource
    )
  )
  return `${PREFIX}${bytesToBase64(iv)}:${bytesToBase64(ct)}`
}

/** 解密；非加密前缀（旧明文/空值）原样返回 → 无需数据迁移；解密失败返回空串 */
export async function decryptSecret(value: string): Promise<string> {
  if (!value || !value.startsWith(PREFIX)) return value
  try {
    const [ivB64, ctB64] = value.slice(PREFIX.length).split(':')
    const key = await getKey()
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(ivB64) as BufferSource },
      key,
      base64ToBytes(ctB64) as BufferSource
    )
    return new TextDecoder().decode(pt)
  } catch {
    return ''
  }
}
