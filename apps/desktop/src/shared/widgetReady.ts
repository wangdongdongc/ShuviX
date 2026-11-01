/**
 * 小组件页面「已经画好了」的信号 —— 承载它的 iframe（渲染端 WidgetFrame）收到之前一直透明，不让人看见空白页、
 * 「Loading…」这类一闪而过的中间态；收到才淡入。手机远程打开时这些中间态每一个都是整屏一闪。
 *
 * 信号由 widget 服务的页面骨架发（widgetServer.ts 的 hostHTML 把 `widgetReadyScript()` 紧排在主题脚本之后，
 * 早于组件的 bundle）：`#root` 里有了东西、开头那批请求（首屏数据）都回来了、页面安静了 `WIDGET_READY_QUIET_MS`
 * 之后，等这一帧画出去，向父页面 `postMessage({ type: WIDGET_READY_MESSAGE })`。最多等 `WIDGET_READY_MAX_WAIT_MS`
 * （首屏数据再慢也不再等，之后照常看见组件自己的加载态）。请求是包一层 `window.fetch` 数出来的，信号发出就换回原样
 * —— 不改组件的客户端（`shuvix/widget`，它还抄在导出模板里），老组件直接 fetch 的 `/db/` 也一样数得到。
 *
 * 信号只说「可以揭开了」，不带任何数据；组件自己的代码也发得出来，那只影响它自己什么时候露面。
 * 预览窗口（widgetPreviewService）里页面就是顶层，没有父页面，不发。
 *
 * 纯字符串：主进程（拼进页面骨架）与渲染端（认消息）都引。
 */

/** postMessage 的 `type` */
export const WIDGET_READY_MESSAGE = 'shuvix-widget:ready'

/** 从页面脚本开始算，最多等这么久就发信号 */
export const WIDGET_READY_MAX_WAIT_MS = 2000

/** DOM 没有变动、也没有请求刚回来，这么久才算画完 */
export const WIDGET_READY_QUIET_MS = 80

/** 是不是那条信号（来源由收的一方自己核对：`event.source` 是不是它的 iframe） */
export function isWidgetReadyMessage(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === WIDGET_READY_MESSAGE
  )
}

/** 一行，给构建失败页这类没有组件可等的页面：有父页面就立刻发 */
export function widgetReadyNowScript(): string {
  return `if (window.parent !== window) { try { window.parent.postMessage({ type: ${JSON.stringify(WIDGET_READY_MESSAGE)} }, '*') } catch (_) {} }`
}

/**
 * 页面骨架里的就绪脚本（放进 `<script>`，要排在组件 bundle 之前：它得先包好 fetch）。
 *
 * - 「有东西」= `#root` 有子元素（组件没挂上时骨架自己的 300ms 看门狗也会往里写一段说明，同样算）；
 * - 「安静」= 整个文档 `QUIET` 毫秒没有 DOM 变动、也没有请求刚回来 —— 请求回来之后组件还要读 body、setState、
 *   渲染，这一段靠「回来也算一次变动」盖住；
 * - 等一帧：两次 requestAnimationFrame（帧被节流时退回 100ms 的定时器）。
 */
export function widgetReadyScript(): string {
  return `(function () {
  if (window.parent === window) return;
  var MSG = ${JSON.stringify(WIDGET_READY_MESSAGE)}, MAX = ${WIDGET_READY_MAX_WAIT_MS}, QUIET = ${WIDGET_READY_QUIET_MS};
  var start = Date.now(), last = start, pending = 0, sent = false, timer = 0, observer = null;
  var realFetch = window.fetch;
  function wrapped() {
    var p = realFetch.apply(window, arguments);
    if (!sent) {
      pending++;
      var end = function () { pending--; touch(); };
      p.then(end, end);
    }
    return p;
  }
  function post() {
    if (sent) return;
    sent = true;
    clearTimeout(timer);
    if (window.fetch === wrapped) window.fetch = realFetch;
    if (observer) observer.disconnect();
    var done = false;
    var go = function () {
      if (done) return;
      done = true;
      try { window.parent.postMessage({ type: MSG }, '*'); } catch (_) {}
    };
    setTimeout(go, 100);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { requestAnimationFrame(go); });
    }
  }
  function check() {
    clearTimeout(timer);
    if (sent) return;
    var now = Date.now();
    var left = MAX - (now - start);
    if (left <= 0) return post();
    var root = document.getElementById('root');
    var wait = left;
    if (root && root.childElementCount > 0 && pending === 0) {
      if (now - last >= QUIET) return post();
      wait = Math.min(left, QUIET - (now - last));
    }
    timer = setTimeout(check, wait);
  }
  function touch() { last = Date.now(); check(); }
  if (typeof realFetch === 'function') window.fetch = wrapped;
  observer = new MutationObserver(touch);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  check();
})();`
}
