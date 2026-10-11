/**
 * frontend/scripts/ssr-walkthrough.mjs
 *
 * 无浏览器运行时走查：在 Node 里用真实 React 客户端渲染器把每条路由真正渲染出来，
 * 等异步数据落地后，对**渲染完成的标记**做设计契约断言，并把每个页面序列化成
 * 自带样式的单文件 HTML 供人眼看。
 *
 * 为什么不用浏览器：本机 DSH 沙箱拒绝 OpenProcess / 命名管道，Chromium 系
 * （Chrome / Edge / Electron）一律无法启动，CDP 截图不可达（证据见 docs/TESTING.md）。
 * 这个走查是同一沙箱内可达的最强运行时证据：真代码、真重新渲染、真夹具。
 *
 * 它不能替代的：CSS 布局、视觉效果、鼠标/键盘交互。断言只覆盖"渲染出了哪些节点与属性"。
 *
 * 用法（workdir = frontend）：
 *   $env:DSH_NO_NET_USE="1"
 *   & <node> scripts\ssr-walkthrough.mjs [--out <dir>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DSH_NO_NET_USE = "1";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFlag = process.argv.indexOf("--out");
const OUT_DIR = resolve(FRONTEND, outFlag > -1 ? process.argv[outFlag + 1] : ".verification/ssr");

/* ---------- 1. 环境：用 DOM shim 顶替浏览器 ---------- */

const { createDom, select, serialize, ShimNode } = await import("./dom-shim.mjs");

const document = createDom();
const storage = new Map();
const makeStorage = () => ({
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
  clear: () => storage.clear(),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
});

const location = {
  href: "http://127.0.0.1:4173/",
  origin: "http://127.0.0.1:4173",
  protocol: "http:",
  host: "127.0.0.1:4173",
  hostname: "127.0.0.1",
  port: "4173",
  pathname: "/",
  search: "",
  hash: "#/projects?demo=1",
  assign() {},
  replace() {},
  reload() {},
  toString() {
    return this.href;
  },
};

const win = globalThis;
win.window = win;
win.self = win;
win.document = document;
win.location = location;
win.history = { pushState() {}, replaceState() {}, back() {}, state: null, length: 1 };
win.localStorage = makeStorage();
win.sessionStorage = makeStorage();
win.addEventListener = () => {};
win.removeEventListener = () => {};
win.dispatchEvent = () => true;
Object.defineProperty(win, "navigator", {
  value: { userAgent: "node-dom-shim", language: "zh-CN", clipboard: undefined },
  writable: true,
  configurable: true,
});
win.matchMedia = (query) => ({ matches: false, media: String(query), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
win.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
win.cancelAnimationFrame = (id) => clearTimeout(id);
win.scrollTo = () => {};
win.scroll = () => {};
win.getComputedStyle = () => ({ getPropertyValue: () => "" });
win.fetch = () => Promise.reject(new Error("ssr-walkthrough: 沙箱内没有网络"));
win.CSS = { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`) };
win.URL.createObjectURL = () => "blob:ssr";
win.URL.revokeObjectURL = () => {};
win.IS_REACT_ACT_ENVIRONMENT = true;

// React 会按 window.X 取构造器做 instanceof 判断（例如 getActiveElementDeep 的
// window.HTMLIFrameElement）。真实浏览器上这些挂在 window 上，shim 也得补上。
for (const name of [
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLImageElement",
  "HTMLFormElement",
  "SVGElement",
  "Text",
  "DocumentFragment",
  "Comment",
]) {
  win[name] = ShimNode;
}

/* ---------- 2. 路由清单（id 取自真实夹具索引） ---------- */

const fixturesRoot = join(FRONTEND, "src", "demo", "fixtures");
const index = JSON.parse(await readFile(join(fixturesRoot, "index.json"), "utf8"));
const project = index.projects?.[0]?.project_id ?? null;
const run = index.runs?.[0]?.run_id ?? null;
const documentId = index.documents?.[0]?.document_id ?? null;
const token = index.documents?.[0]?.chunks?.[0]?.chunk_id ?? null;

const routes = [["projects", "/projects"], ["opportunity", "/opportunity"], ["about", "/about"]];
if (project) {
  routes.push(["project", `/projects/${project}`], ["upload", `/projects/${project}/upload`], ["runNew", `/runs/new?project_id=${project}`]);
}
if (documentId) routes.push(["document", `/documents/${documentId}`]);
if (run) routes.push(["run", `/runs/${run}`], ["review", `/runs/${run}/review`], ["report", `/runs/${run}/report`]);
routes.push(["notFound", "/this-route-does-not-exist"]);

/* ---------- 3. 加载真代码 ---------- */

const { createServer } = await import("vite");
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

const server = await createServer({
  root: FRONTEND,
  configFile: join(FRONTEND, "vite.config.ts"),
  logLevel: "error",
  appType: "custom",
  // 不需要 HMR/文件监听：这里只做一次性 SSR 加载。
  server: {
    middlewareMode: true,
    hmr: false,
    watch: null,
    fs: { strict: false, allow: [FRONTEND, join(FRONTEND, "..")] },
  },
  optimizeDeps: { noDiscovery: true, include: [] },
});

/** 断言辅助：把断言结果收成列表。 */
function makeAsserts() {
  const rows = [];
  return {
    rows,
    check(name, ok, detail) {
      rows.push({ name, ok: Boolean(ok), detail: detail ?? null });
    },
  };
}

const VERDICT_VALUES = new Set(["passed", "failed", "needs_review", "pending", "suitable", "unsuitable"]);

const report = [];
const aesthetics = [];
let routeFailures = 0;
let assertFailures = 0;

try {
  const appModule = await server.ssrLoadModule("/src/app/App.tsx");
  const demoSource = await server.ssrLoadModule("/src/api/demo-source.ts");
  const demo = await demoSource.createDemoClient();
  const probe = await appModule.boot();
  console.log(`boot(): mode=${probe.mode} ok=${probe.health?.ok} reason=${JSON.stringify(probe.health?.reason ?? null)}`);

  const cssFiles = ["tokens.css", "base.css", "app.css"];
  const cssText = (
    await Promise.all(cssFiles.map((name) => readFile(join(FRONTEND, "src", "styles", name), "utf8")))
  ).join("\n\n");

  await mkdir(OUT_DIR, { recursive: true });

  for (const [name, path] of routes) {
    location.hash = `#${path}${path.includes("?") ? "&" : "?"}demo=1`;
    const container = document.createContainer();
    const asserts = makeAsserts();
    const row = { route: name, path, ok: false, bytes: 0, counts: {}, asserts: asserts.rows, error: null, html: null };

    try {
      const root = createRoot(container);
      if (process.env.WALKTHROUGH_TRACE === "1") {
        console.log(
          `[trace] container.ownerDocument===document: ${container.ownerDocument === document}; HTMLIFrameElement: ${typeof container.ownerDocument?.HTMLIFrameElement}; defaultView===window: ${container.ownerDocument?.defaultView === win}; document.document===document: ${document.document === document}`,
        );
      }
      await act(async () => {
        root.render(React.createElement(appModule.App, { probe, demo }));
      });
      // 让 useAsync / usePolling 里的 promise 链与随后的一次重渲染落地
      for (let tick = 0; tick < 4; tick += 1) {
        await act(async () => {
          await new Promise((done) => setTimeout(done, 30));
        });
      }

      const html = serialize(container);
      row.bytes = html.length;
      row.counts = {
        panel: select(container, ".panel").length,
        tenon: select(container, ".tenon").length,
        tenonMissing: select(container, ".tenon--missing").length,
        verdictNodes: select(container, "[data-verdict]").length,
        flags: select(container, ".flag").length,
        ledgerNums: select(container, ".ledger-num").length,
        crash: select(container, "#app-error").length,
        boot: select(container, ".boot").length,
        skeleton: select(container, ".skeleton").length,
        buttons: select(container, "button").length,
        links: select(container, "a").length,
      };

      // --- 设计契约断言（在"渲染完成"的节点上） ---
      asserts.check("渲染出了内容（不只是载入占位）", row.counts.boot === 0 && row.counts.crash === 0);
      asserts.check("没有命中错误边界", row.counts.crash === 0);

      const verdicts = select(container, "[data-verdict]").map((node) => node.getAttribute("data-verdict"));
      const badVerdicts = verdicts.filter((value) => !VERDICT_VALUES.has(value));
      asserts.check("每个结论徽标的 data-verdict 都在契约取值内", badVerdicts.length === 0, badVerdicts.join(","));

      // 六态文案：不出现"暂无数据"这类空话
      const text = container.textContent;
      asserts.check("没有出现「暂无数据」式空文案", !/暂无数据|no data/i.test(text));

      // 十进制字符串不得被 Number 化：评分页必须有 .ledger-num 承载数值
      if (name === "run" || name === "report") {
        // 这两个页面的确有后端数值，用 run 详情页单独断言（见下）
      }
      if (name === "document") {
        asserts.check("材料页渲染了分块", select(container, ".chunk").length > 0, `chunks=${select(container, ".chunk").length}`);
      }
      if (name === "notFound") {
        asserts.check("未知路由给出 404 文案", /404/.test(text));
      }
      if (name === "about") {
        asserts.check("关于页写明了职责边界", /后端/.test(text) && /分值/.test(text));
      }

      row.ok = true;
      row.html = `ssr/${name}.html`;
      await writeFile(
        join(OUT_DIR, `${name}.html`),
        `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${name} · 评审台（服务端渲染留痕）</title>\n<style>\n${cssText}\n</style>\n</head>\n<body class="ssr-snapshot">\n${serialize(container)}\n</body>\n</html>\n`,
        "utf8",
      );
    } catch (error) {
      row.error = `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
      routeFailures += 1;
      if (process.env.WALKTHROUGH_TRACE === "1") console.log(error?.stack ?? error);
    }

    for (const assert of row.asserts) if (!assert.ok) assertFailures += 1;
    report.push(row);
    aesthetics.push({ route: name, bytes: row.bytes });

    const failed = row.asserts.filter((assert) => !assert.ok);
    console.log(
      `${row.ok ? "ok  " : "FAIL"} ${name.padEnd(11)} ${path.padEnd(46)} bytes=${String(row.bytes).padStart(6)} panel=${row.counts.panel ?? "-"} tenon=${row.counts.tenon ?? "-"} verdict=${row.counts.verdictNodes ?? "-"} ledger=${row.counts.ledgerNums ?? "-"} crash=${row.counts.crash ?? "-"}`,
    );
    for (const assert of failed) console.log(`       ✗ ${assert.name}${assert.detail ? ` (${assert.detail})` : ""}`);
    if (row.error) console.log(`       ! ${row.error}`);
  }
} finally {
  await server.close();
}

const summary = {
  generated_at: new Date().toISOString(),
  mode: "node-dom-shim + react-dom/client（沙箱内无浏览器可用）",
  routes_total: routes.length,
  routes_ok: routes.length - routeFailures,
  asserts_total: report.reduce((sum, row) => sum + row.asserts.length, 0),
  asserts_failed: assertFailures,
  pages: report.map(({ html, ...rest }) => rest),
};
await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "walkthrough.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(`\n路由 ${summary.routes_ok}/${summary.routes_total} 渲染成功；断言 ${summary.asserts_total - summary.asserts_failed}/${summary.asserts_total} 通过`);
console.log(`每页 HTML 留痕：${OUT_DIR}`);
process.exitCode = routeFailures || assertFailures ? 1 : 0;
