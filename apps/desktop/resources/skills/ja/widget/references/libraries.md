# Libraries

Besides React, React DOM, React Router and `shuvix/widget`, a widget's screen can import the libraries below. ShuviX ships them inside the app at these exact versions, so nothing is installed and the widget works offline. Any other package fails the build, and so does an import from a URL: never add a script or stylesheet from a CDN, because code from the internet would run with the widget's access to the user's files. `api.ts` still imports only `shuvix/widget-api` and `zod`.

Import by name what you use. The build keeps what the widget imports and drops the rest: `import { Plus } from 'lucide-react'` adds one icon, not the whole set.

| Need                                         | Library and version                                           | Import                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Icons                                        | `lucide-react` 0.564.0                                        | `import { Plus, Trash2 } from 'lucide-react'`                                                                    |
| Charts                                       | `chart.js` 4.6.1                                              | `import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale } from 'chart.js'`        |
| Time series with tens of thousands of points | `uplot` 1.6.32                                                | `import uPlot from 'uplot'` and `import 'uplot/dist/uPlot.min.css'`                                              |
| A custom figure Chart.js cannot draw         | `d3` 7.9.0                                                    | `import { scaleLinear, line, select } from 'd3'`                                                                 |
| CSV                                          | `papaparse` 5.7.0                                             | `import Papa from 'papaparse'`                                                                                   |
| Date arithmetic                              | `dayjs` 1.11.23                                               | `import dayjs from 'dayjs'`                                                                                      |
| Markdown                                     | `marked` 18.1.2 with `dompurify` 3.4.17                       | `import { marked } from 'marked'` and `import DOMPurify from 'dompurify'`                                        |
| Drag to reorder, boards                      | `@dnd-kit/core` 6.3.1, `/sortable` 10.0.0, `/utilities` 3.2.2 | `import { DndContext } from '@dnd-kit/core'`, `import { SortableContext, useSortable } from '@dnd-kit/sortable'` |
| A list of thousands of rows                  | `@tanstack/react-virtual` 3.14.24                             | `import { useVirtualizer } from '@tanstack/react-virtual'`                                                       |
| Fuzzy search                                 | `fuse.js` 7.5.0                                               | `import Fuse from 'fuse.js'`                                                                                     |
| Comparing texts                              | `diff` 8.0.4                                                  | `import { diffWords, diffLines } from 'diff'`                                                                    |
| QR codes                                     | `qrcode` 1.5.4                                                | `import QRCode from 'qrcode'`, then `QRCode.toDataURL(text)` (a Promise)                                               |
| YAML                                         | `yaml` 2.9.0                                                  | `import { parse, stringify } from 'yaml'`                                                                        |
| Code highlighting                            | `highlight.js` 11.11.1                                        | see below                                                                                                        |
| 3D                                           | `three` 0.187.0                                               | `import * as THREE from 'three'`, see below                                                                      |

## Notes

**Icons**: lucide icons draw in `currentColor`, so color them with a text color name and size them with `size-*`: `<Trash2 className="size-4 text-fg-muted" />`.

**Charts take colors as values**, so they follow the theme only through `themeColor()` (`design.md`). Create the chart in an effect that depends on `useTheme()` and the data, and destroy it in the cleanup:

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

Register only the Chart.js parts you use with `Chart.register(…)`; `chart.js/auto` registers everything and adds about 20 KB. Put the canvas in a box with a set height (`h-48`), since `maintainAspectRatio: false` takes the box's size.

**Dates**: formatting stays `Intl.DateTimeFormat` / `toLocaleDateString`; dayjs is for arithmetic (adding days, start of week, the difference between two dates). Plugins import from `dayjs/plugin/<name>` and are turned on with `dayjs.extend(…)`.

**Markdown**: always sanitize what marked produces before it reaches the page: `<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(text, { async: false })) }} />`. Style the result from the container with Tailwind's child selectors (`[&_h2]:font-medium`, `[&_a]:text-accent`).

**Drag and drop**: `useSortable` gives each row `attributes`, `listeners`, `setNodeRef`, `transform` and `transition`; apply the transform with `CSS.Transform.toString(transform)` from `@dnd-kit/utilities` and reorder with `arrayMove` from `@dnd-kit/sortable`. Add a `TouchSensor` (or a `PointerSensor` with an `activationConstraint`) so dragging works on a phone without stealing taps.

**Code highlighting**: import the core and register the languages you need. Importing `highlight.js` itself fails the build, because it would bring every language.

```tsx
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
hljs.registerLanguage('javascript', javascript)
const html = hljs.highlight(code, { language: 'javascript' }).value
```

No highlight.js theme ships: color its classes with the theme's variables in the widget's `.css` file (`.hljs-keyword { color: var(--widget-accent) }`, `.hljs-string { color: var(--widget-viz-2-ink) }`, `.hljs-comment { color: var(--widget-fg-subtle) }`).

**three.js** is large, so it is not bundled into the widget: ShuviX serves one shared copy and the import still reads `import * as THREE from 'three'`. Addons import from `three/addons/…`; these ship: every control in `controls/` (`OrbitControls`, `MapControls`, `TrackballControls`, `TransformControls` …), the loaders `GLTFLoader`, `OBJLoader`, `MTLLoader`, `STLLoader` and `PLYLoader`, `environments/RoomEnvironment.js`, `renderers/CSS2DRenderer.js`, `geometries/RoundedBoxGeometry.js`, and `utils/BufferGeometryUtils.js` and `utils/SkeletonUtils.js`. Any other addon fails the build, and the error lists the ones that ship. React Three Fiber is not available. Create the renderer in an effect on a container `ref`, size it with a `ResizeObserver`, run the loop with `renderer.setAnimationLoop`, and in the cleanup stop the loop and dispose the renderer and the controls. Take the background and material colors from `themeColor()` (`new THREE.Color(themeColor('surface'))`). A model on the user's computer loads from its `fs/file` address like any other file (`files.md`).

## Exporting

The exported project's `package.json` lists every library the widget imports, at the versions above, with the type packages `tsc` needs (`export.md`).
