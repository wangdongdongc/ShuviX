/**
 * 文件扩展名 → CodeMirror 语言扩展的懒加载注册表
 *
 * 每个 ext 对应一个动态 import 工厂；Vite 会把每个 import() 切成独立 chunk，
 * eager bundle 不带任何语言代码，按需在用户打开对应扩展名时拉取。
 *
 * 长尾语言走 @codemirror/legacy-modes —— 每个 mode 一个子路径，独立 chunk 1-4KB。
 *
 * 缓存 + reqId 防御快速切文件竞态：调用方负责通过 reqId 比对决定是否应用结果。
 */

import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'

type Loader = () => Promise<Extension | null>

const loaders: Record<string, Loader> = {
  // ===== 官方语言包 =====
  '.ts': () =>
    import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  '.tsx': () =>
    import('@codemirror/lang-javascript').then((m) =>
      m.javascript({ typescript: true, jsx: true })
    ),
  '.js': () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  '.jsx': () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  '.mjs': () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  '.cjs': () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  '.json': () => import('@codemirror/lang-json').then((m) => m.json()),
  '.jsonc': () => import('@codemirror/lang-json').then((m) => m.json()),
  '.py': () => import('@codemirror/lang-python').then((m) => m.python()),
  '.html': () => import('@codemirror/lang-html').then((m) => m.html()),
  '.htm': () => import('@codemirror/lang-html').then((m) => m.html()),
  '.xml': () => import('@codemirror/lang-xml').then((m) => m.xml()),
  '.svg': () => import('@codemirror/lang-xml').then((m) => m.xml()),
  '.css': () => import('@codemirror/lang-css').then((m) => m.css()),
  '.yaml': () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  '.yml': () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  '.sql': () => import('@codemirror/lang-sql').then((m) => m.sql()),
  '.java': () => import('@codemirror/lang-java').then((m) => m.java()),
  '.c': () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  '.h': () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  '.cpp': () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  '.cc': () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  '.hpp': () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  '.go': () => import('@codemirror/lang-go').then((m) => m.go()),
  '.rs': () => import('@codemirror/lang-rust').then((m) => m.rust()),
  '.php': () => import('@codemirror/lang-php').then((m) => m.php()),

  // ===== legacy-modes 长尾 =====
  '.sh': () =>
    import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  '.bash': () =>
    import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  '.zsh': () =>
    import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  '.fish': () =>
    import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  '.env': () =>
    import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  '.gitignore': () =>
    import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  '.ps1': () =>
    import('@codemirror/legacy-modes/mode/powershell').then((m) =>
      StreamLanguage.define(m.powerShell)
    ),
  '.rb': () =>
    import('@codemirror/legacy-modes/mode/ruby').then((m) => StreamLanguage.define(m.ruby)),
  '.lua': () =>
    import('@codemirror/legacy-modes/mode/lua').then((m) => StreamLanguage.define(m.lua)),
  '.r': () => import('@codemirror/legacy-modes/mode/r').then((m) => StreamLanguage.define(m.r)),
  '.swift': () =>
    import('@codemirror/legacy-modes/mode/swift').then((m) => StreamLanguage.define(m.swift)),
  '.dockerfile': () =>
    import('@codemirror/legacy-modes/mode/dockerfile').then((m) =>
      StreamLanguage.define(m.dockerFile)
    ),
  '.kt': () =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.kotlin)),
  '.cs': () =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.csharp)),
  '.scala': () =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.scala)),
  '.dart': () =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.dart)),
  '.scss': () =>
    import('@codemirror/legacy-modes/mode/css').then((m) => StreamLanguage.define(m.sCSS)),
  '.less': () =>
    import('@codemirror/legacy-modes/mode/css').then((m) => StreamLanguage.define(m.less)),
  '.ini': () =>
    import('@codemirror/legacy-modes/mode/properties').then((m) =>
      StreamLanguage.define(m.properties)
    ),
  '.toml': () =>
    import('@codemirror/legacy-modes/mode/properties').then((m) =>
      StreamLanguage.define(m.properties)
    ),
  '.makefile': () =>
    import('@codemirror/legacy-modes/mode/cmake').then((m) => StreamLanguage.define(m.cmake)),
  '.mk': () =>
    import('@codemirror/legacy-modes/mode/cmake').then((m) => StreamLanguage.define(m.cmake))

  // .txt / .log / .csv / .md / 未知扩展 → 不注册，plaintext fallback
}

const cache = new Map<string, Extension | null>()

/**
 * 异步取得指定扩展名的 CodeMirror 语言扩展。
 * - 命中注册表：动态 import 对应包，结果按 ext 缓存（每个 ext 只 import 一次）
 * - 未注册：返回 null，调用方应用 plaintext（即不挂 language extension）
 *
 * 注意：caller 应通过 reqId 比对决定是否真的把结果 dispatch 到 EditorView，
 * 避免用户快速切文件时旧 promise 异步覆盖新文件的语言。
 */
export async function loadLanguage(ext: string): Promise<Extension | null> {
  const key = ext.toLowerCase()
  if (cache.has(key)) return cache.get(key) ?? null
  const loader = loaders[key]
  const result = loader ? await loader() : null
  cache.set(key, result)
  return result
}
