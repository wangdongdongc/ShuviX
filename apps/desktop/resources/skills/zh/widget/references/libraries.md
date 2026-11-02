# 库

除了 React、React DOM、React Router 和 `shuvix/widget`，小组件的界面还能 import 下面这些库。ShuviX 把它们按这些精确版本放在应用里一起发，所以什么都不用安装，小组件离线也能用。别的包会让构建失败，从 URL import 也一样：永远不要从 CDN 加脚本或样式表，因为来自网上的代码会带着小组件读用户文件的权限运行。`api.ts` 仍然只能 import `shuvix/widget-api` 和 `zod`。

用到什么就按名字 import 什么。构建只留下小组件 import 的部分，其余丢掉：`import { Plus } from 'lucide-react'` 只带进一个图标，不是整套。

| 需要                      | 库与版本                                                      | Import                                                                                                           |
| ------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 图标                      | `lucide-react` 0.564.0                                        | `import { Plus, Trash2 } from 'lucide-react'`                                                                    |
| 图表                      | `chart.js` 4.6.1                                              | `import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale } from 'chart.js'`        |
| 上万个点的时间序列        | `uplot` 1.6.32                                                | `import uPlot from 'uplot'` 和 `import 'uplot/dist/uPlot.min.css'`                                               |
| Chart.js 画不了的自定义图 | `d3` 7.9.0                                                    | `import { scaleLinear, line, select } from 'd3'`                                                                 |
| CSV                       | `papaparse` 5.7.0                                             | `import Papa from 'papaparse'`                                                                                   |
| 日期运算                  | `dayjs` 1.11.23                                               | `import dayjs from 'dayjs'`                                                                                      |
| Markdown                  | `marked` 18.1.2 配 `dompurify` 3.4.17                         | `import { marked } from 'marked'` 和 `import DOMPurify from 'dompurify'`                                         |
| 拖拽排序、看板            | `@dnd-kit/core` 6.3.1、`/sortable` 10.0.0、`/utilities` 3.2.2 | `import { DndContext } from '@dnd-kit/core'`、`import { SortableContext, useSortable } from '@dnd-kit/sortable'` |
| 几千行的列表              | `@tanstack/react-virtual` 3.14.24                             | `import { useVirtualizer } from '@tanstack/react-virtual'`                                                       |
| 模糊搜索                  | `fuse.js` 7.5.0                                               | `import Fuse from 'fuse.js'`                                                                                     |
| 文本对比                  | `diff` 8.0.4                                                  | `import { diffWords, diffLines } from 'diff'`                                                                    |
| 二维码                    | `qrcode` 1.5.4                                                | `import QRCode from 'qrcode'`，然后 `QRCode.toDataURL(text)`（返回 Promise）                                               |
| YAML                      | `yaml` 2.9.0                                                  | `import { parse, stringify } from 'yaml'`                                                                        |
| 代码高亮                  | `highlight.js` 11.11.1                                        | 见下                                                                                                             |
| 3D                        | `three` 0.187.0                                               | `import * as THREE from 'three'`，见下                                                                           |

## 说明

**图标**：lucide 图标用 `currentColor` 画，所以用文字颜色名上色、用 `size-*` 定大小：`<Trash2 className="size-4 text-fg-muted" />`。

**图表的颜色是值**，只能通过 `themeColor()` 跟随主题（`design.md`）。在依赖 `useTheme()` 和数据的 effect 里创建图表，在清理函数里销毁：

```tsx
const theme = useTheme()
useEffect(() => {
  const chart = new Chart(canvasRef.current!, {
    type: 'line',
    data: {
      labels,
      datasets: [{ data: values, borderColor: themeColor('viz-1'), pointRadius: 0 }]
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: themeColor('fg-muted') }, grid: { display: false } },
        y: { ticks: { color: themeColor('fg-muted') }, grid: { color: themeColor('line-subtle') } }
      }
    }
  })
  return () => chart.destroy()
}, [theme, labels, values])
```

只用 `Chart.register(…)` 注册用到的 Chart.js 部件；`chart.js/auto` 会注册全部，多出约 20 KB。canvas 要放在定了高度的盒子里（`h-48`），因为 `maintainAspectRatio: false` 取的是盒子的大小。

**日期**：格式化仍然用 `Intl.DateTimeFormat` / `toLocaleDateString`；dayjs 用来做运算（加几天、一周的开头、两个日期差多少）。插件从 `dayjs/plugin/<name>` import，用 `dayjs.extend(…)` 打开。

**Markdown**：marked 生成的东西进页面之前一律消毒：`<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(text, { async: false })) }} />`。结果的样式从容器上用 Tailwind 的子元素选择器写（`[&_h2]:font-medium`、`[&_a]:text-accent`）。

**拖拽**：`useSortable` 给每一行 `attributes`、`listeners`、`setNodeRef`、`transform` 和 `transition`；用 `@dnd-kit/utilities` 的 `CSS.Transform.toString(transform)` 套上位移，用 `@dnd-kit/sortable` 的 `arrayMove` 重排。加一个 `TouchSensor`（或带 `activationConstraint` 的 `PointerSensor`），这样在手机上能拖，又不会吃掉点按。

**代码高亮**：import 核心，再注册要用的语言。直接 import `highlight.js` 会让构建失败，因为那会带进所有语言。

```tsx
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
hljs.registerLanguage('javascript', javascript)
const html = hljs.highlight(code, { language: 'javascript' }).value
```

不提供 highlight.js 的主题：在小组件的 `.css` 文件里用主题变量给它的类上色（`.hljs-keyword { color: var(--widget-accent) }`、`.hljs-string { color: var(--widget-viz-2-ink) }`、`.hljs-comment { color: var(--widget-fg-subtle) }`）。

**three.js** 很大，所以不打进小组件：ShuviX 提供共用的一份，import 照样写 `import * as THREE from 'three'`。addon 从 `three/addons/…` import，能在 WebGL 渲染器上跑的都有：控制器、加载器（glTF、FBX、OBJ、STL、PLY、Collada、3MF、HDR、EXR、KTX2 等等）、后处理、着色器、几何体、辅助对象和工具。没有的：WebGPU 与 TSL 那些文件、`Addons.js`（每个 addon 按自己的路径 import），以及要用别处的库的 `TTFLoader`、`3DMLoader`、`DRACOExporter` 和 `physics/`。构建报错会说那个文件夹里有什么。没有 React Three Fiber。在一个容器 `ref` 上的 effect 里创建渲染器，用 `ResizeObserver` 定大小，用 `renderer.setAnimationLoop` 跑循环，在清理函数里停掉循环并 dispose 渲染器和控制器。背景和材质的颜色取自 `themeColor()`（`new THREE.Color(themeColor('surface'))`）。

**用户电脑上的模型**从它的 `fileAtUrl` 地址加载（`files.md`），不要用 `fileUrl`：模型大多提到旁边的其他文件，加载器从这个地址能自己找到它们，不用 `LoadingManager` 改写。压缩过的模型还要解码器，这些也提供，加载器不用指定解码器路径就能找到：

```ts
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

new GLTFLoader()
  .setDRACOLoader(new DRACOLoader())
  .setKTX2Loader(new KTX2Loader().detectSupport(renderer))
  .setMeshoptDecoder(MeshoptDecoder)
  .load(fileAtUrl('~/models/robot/robot.gltf'), (gltf) => {
    scene.add(gltf.scene)
    document.body.dataset.ready = '1'
  })
```

**检查 3D 界面**：`preview` 会等页面的请求，但不等解析和第一次绘制。像上面那样在模型画好时标个记号，再用 `wait_for: "[data-ready]"` 预览。没有 GPU 的服务器上它也能渲染 WebGL，走软件渲染，所以重的场景在那里会慢。着色器错误会出现在它返回的错误里。

**没有提供的 addon**，比如 three 已经删掉的（`.pmx` 用的 `MMDLoader` 最后出现在 three 0.171.0）：把它和它 import 的文件从那个版本下载到小组件的文件夹里，例如 `curl -L https://unpkg.com/three@0.171.0/examples/jsm/loaders/MMDLoader.js`，保持相对目录，用相对路径 import。这样它就是小组件自己的代码，离线也能用。里面的 `from 'three'` 不要动，让它跑在共用的那一份上，然后预览。只有出现着色器错误时才需要它原本配的引擎：把那个版本的 `build/three.module.min.js` 也下载下来（小组件会多大约 700 KB），把 addon 和你自己文件里每一处 `from 'three'` 都改成指向它的相对路径，再用 `grep -rn "from 'three'" .` 确认一处不剩。一个页面上有两份 three，模型会不声不响地显示不出来。不要为了绕开这些去造带自己 import map 或 blob 地址的 iframe。

## 导出

导出项目的 `package.json` 会列出小组件 import 的每个库，版本同上，并带上 `tsc` 需要的类型包（`export.md`）。
