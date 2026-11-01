/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * electron-builder afterPack 钩子
 * - 所有平台：小组件可用的库（resources/bundler/vendor，postinstall 里 scripts/vendor-widget-libs.mjs 拷的）
 *   必须进了包 —— 少了它，用到这些库的小组件在装好的应用里 build 不出来，而开发时一切正常
 * - 有开发者证书时（CI 环境设置了 CSC_LINK），electron-builder 已自动签名，跳过此钩子
 * - 无证书时，对整个 .app 包进行 ad-hoc 签名，避免 Team ID 不一致导致启动崩溃
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function checkWidgetVendor(resourcesDir) {
  const vendor = path.join(resourcesDir, 'bundler', 'vendor')
  const manifestPath = path.join(vendor, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `[afterPack] ${manifestPath} is missing: run npm install (or node scripts/vendor-widget-libs.mjs) before packaging`
    )
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const missing = Object.keys(manifest.packages).filter(
    (pkg) => !fs.existsSync(path.join(vendor, 'node_modules', pkg, 'package.json'))
  )
  if (missing.length > 0) {
    throw new Error(`[afterPack] widget libraries missing from the package: ${missing.join(', ')}`)
  }
  const count = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0)
  const packaged = count(path.join(vendor, 'node_modules'))
  if (packaged !== manifest.fileCount) {
    throw new Error(
      `[afterPack] ${packaged} widget library files were packaged, ${manifest.fileCount} were vendored`
    )
  }
  console.log(`[afterPack] widget libraries: ${Object.keys(manifest.libraries).length} present`)
}

exports.checkWidgetVendor = checkWidgetVendor

exports.default = async function (context) {
  const resourcesDir =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : path.join(context.appOutDir, 'resources')
  checkWidgetVendor(resourcesDir)

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
