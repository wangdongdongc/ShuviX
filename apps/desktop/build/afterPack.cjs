/**
 * electron-builder afterPack 钩子
 * - 有开发者证书时（CI 环境设置了 CSC_LINK），electron-builder 已自动签名，跳过此钩子
 * - 无证书时，对整个 .app 包进行 ad-hoc 签名，避免 Team ID 不一致导致启动崩溃
 */
const { execSync } = require('child_process')
const path = require('path')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  // 有正式证书时 electron-builder 已完成签名，不需要 ad-hoc 重签
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[afterPack] Developer certificate detected, skipping ad-hoc signing')
    return
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`[afterPack] No certificate found, ad-hoc re-signing: ${appPath}`)
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: 'inherit'
  })
}
