#!/usr/bin/env node
/**
 * frontend/tools/screenshot.mjs
 * 用 CDP 驱动本机 Chrome，把每个页面 × 每个视口 × 每个主题截成 PNG，并输出 JSON 汇总。
 *
 * 用法：
 *   node tools/screenshot.mjs --base http://127.0.0.1:5173 --out .verification/shots \
 *     --pages "projects=#/projects,report=#/runs/demo-run/report" --theme light --width 1440 --full
 * 无 --pages 时读取 tools/pages.json。
 *
 * 退出码：0=全部通过；1=有页面失败/控制台 error；2=参数或浏览器启动失败（致命）。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_WIDTHS,
  REPO_ROOT,
  argBool,
  argList,
  argNumber,
  argString,
  defaultHeightFor,
  formatError,
  generateRunId,
  loadPagesFile,
  log,
  parseCliArgs,
  printHelp,
  relativeToCwd,
  resolvePages,
  safeName,
  shortUrl,
  warn,
  writeJson,
} from "./cli.mjs";
import { Browser, CdpError, ensureDir, resolveChromePath, sleep, writePng } from "./cdp.mjs";
import { detectUnimplemented } from "./lib/checks.mjs";

const TOOL = "screenshot";
const HELP = [
  "screenshot.mjs — CDP 截图工具（离线，无第三方依赖）",
  "",
  "用法：",
  '  node tools/screenshot.mjs --base http://127.0.0.1:5173 --out ..\\.verification\\shots \\',
  '    --pages "projects=#/projects,report=#/runs/demo-run/report" --theme light,dark --width 1440,390 [--full]',
  "",
  "参数：",
  "  --base <url>        页面根地址（必填）。dev 服务器 http://127.0.0.1:5173，preview http://127.0.0.1:4173",
  "  --pages <spec>      name=#/hash 逗号分隔；缺省读取 tools/pages.json",
  "  --pages-file <p>    指定页面清单文件（默认 tools/pages.json）",
  "  --out <dir>         输出目录（默认 <repo>/.verification/shots）",
  "  --width <n[,n]>     视口宽度，默认 1440,390；高度按 defaultHeightFor 推导（1440→900，390→844）",
  "  --height <n>        强制所有视口高度",
  "  --theme <t[,t]>     light | dark | default（不覆盖主题）。默认 default",
  "  --full              整页截图（默认只截视口）",
  "  --reduced-motion    以 prefers-reduced-motion: reduce 模拟截图",
  "  --allow-missing     将“页面未实现”降级为不失败（仍会记录在 JSON 里）",
  "  --chrome <path>     指定 Chrome 可执行文件",
  "  --timeout <ms>      单页导航/截图超时（默认 30000）",
  "  --keep-profile      保留 Chrome profile 目录（排查用）",
  "  --help              显示本帮助",
  "",
  "产物：",
  "  <out>/<name>-<width>-<theme>.png   截图",
  "  <out>/screenshots.json             每页 URL/标题/截图路径/#root 情况/控制台错误/请求失败",
];
const MAX_WIDTH = 4000;
const MAX_HEIGHT = 4000;

const { args } = parseCliArgs();
if (argBool(args, "help", false) || argBool(args, "h", false)) {
  printHelp(HELP);
  process.exit(0);
}

const base = argString(args, "base", null);
if (!base) {
  warn("缺少 --base（例如 --base http://127.0.0.1:5173）\n\n" + HELP.join("\n"));
  process.exit(2);
}

const outDir = resolve(
  process.cwd(),
  argString(args, "out", null) || join(REPO_ROOT, ".verification", "shots"),
);
const fullPage = argBool(args, "full", false);
const reducedMotion = argBool(args, "reduced-motion", false) || argBool(args, "reducedMotion", false);
const allowMissing = argBool(args, "allow-missing", false) || argBool(args, "allowMissing", false);
const keepProfile = argBool(args, "keep-profile", false) || argBool(args, "keepProfile", false);
const timeoutMs = argNumber(args, "timeout", 30_000);
const chromePath = argString(args, "chrome", null);
const pagesFile = argString(args, "pages-file", null) || argString(args, "pagesFile", null);
const jsonPath = resolve(outDir, argString(args, "json", "screenshots.json"));

const widthList = (argList(args, "width", null) || argList(args, "widths", null) || DEFAULT_WIDTHS)
  .map((w) => Number(w))
  .filter((w) => Number.isFinite(w) && w > 0)
  .slice(0, 8);
const forcedHeight = argNumber(args, "height", null);
const themeList = (argList(args, "theme", null) || argList(args, "themes", null) || ["default"]).map((t) => {
  const v = String(t).trim().toLowerCase();
  if (v === "default" || v === "auto" || v === "none") return { name: "default", value: null };
  if (v === "light" || v === "dark") return { name: v, value: v };
  throw new CdpError(`不支持的主题：${t}（只能是 light / dark / default）`);
});

const { pages, source } = await resolvePages({ pagesSpec: argString(args, "pages", null), pagesFile });
if (!pages.length) {
  warn("页面清单为空：用 --pages 指定，或在 tools/pages.json 里配置");
  process.exit(2);
}

const runId = generateRunId();
const t0 = Date.now();
let browser = null;
const results = [];
let fatal = null;

try {
  await ensureDir(outDir);
  log(`# ${TOOL} 运行 ${runId}`);
  log(`  页面来源：${source}（${pages.length} 页）  基础地址：${base}`);
  log(`  视口：${widthList.map((w) => `${w}x${forcedHeight || defaultHeightFor(w)}`).join(", ")}  主题：${themeList.map((t) => t.name).join(", ")}${fullPage ? "  整页截图" : ""}`);
  log(`  Chrome：${resolveChromePath(chromePath)}`);
  log(`  输出：${relativeToCwd(outDir)}`);

  browser = await Browser.launch({ chromePath, keepProfile, extraArgs: reducedMotion ? [] : [] });
  log(`  Chrome 已就绪：${browser.version ? browser.version.Browser : "(版本未知)"}  端口 ${browser.port}`);

  for (const page of pages) {
    const name = safeName(page.name);
    const pageResults = [];
    for (const width of widthList) {
      const height = forcedHeight || defaultHeightFor(width);
      for (const theme of themeList) {
        const combo = { width, height, theme: theme.name };
        const shotName = `${name}-${width}-${theme.name}.png`;
        const shotPath = join(outDir, shotName);
        const started = Date.now();
        let cdpPage = null;
        const row = {
          page: page.name,
          path: page.path,
          title: page.title,
          needsParam: !!page.needsParam,
          ...combo,
          url: shortUrl(base ? new URL(page.path.startsWith("#") ? "/" + page.path : page.path, base).href : page.path),
          ok: false,
          status: "error",
          reason: null,
          shot: null,
          shotBytes: null,
          root: null,
          h1: null,
          implemented: null,
          implementedReason: null,
          consoleErrors: [],
          pageErrors: [],
          requestFailures: [],
          httpErrors: [],
          durationMs: 0,
        };
        try {
          cdpPage = await browser.newPage({
            width,
            height,
            theme: theme.value,
            reducedMotion: reducedMotion ? true : null,
            timeoutMs,
          });
          const nav = await cdpPage.goto(pageUrlOf(base, page.path), { timeoutMs });
          // 页面级失败证据
          row.consoleErrors = cdpPage.consoleErrors.map((m) => ({ type: m.type, text: m.text }));
          row.pageErrors = cdpPage.pageErrors.map((e) => ({ text: e.text }));
          row.requestFailures = cdpPage.requestFailures.map((f) => ({ url: f.url, errorText: f.errorText }));
          row.httpErrors = cdpPage.httpErrors.map((h) => ({ url: h.url, status: h.status }));

          const audit = await cdpPage.evaluate(
            `(() => {
              const root = document.querySelector("#root");
              const eb = document.querySelector("#app-error");
              const bodyText = ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim();
              return {
                url: location.href,
                title: document.title,
                lang: document.documentElement.getAttribute("lang"),
                root: { exists: !!root, children: root ? root.children.length : 0, textLength: root ? (root.textContent || "").trim().length : 0 },
                errorBoundary: { present: !!eb, text: eb ? (eb.textContent || "").trim().slice(0, 200) : "" },
                h1: (document.querySelector("h1") ? (document.querySelector("h1").textContent || "").trim() : "").slice(0, 90),
                bodyTextLength: bodyText.length,
                bodyTextSample: bodyText.slice(0, 200),
              };
            })()`,
            { timeoutMs },
          );
          const verdict = detectUnimplemented(audit);
          row.root = audit.root;
          row.h1 = audit.h1;
          row.title = audit.title || row.title;
          row.url = shortUrl(audit.url || row.url);
          row.implemented = verdict.implemented;
          row.implementedReason = verdict.reason || null;

          const png = await cdpPage.screenshot({ fullPage, timeoutMs });
          await writePng(shotPath, png);
          row.shot = relativeToCwd(shotPath);
          row.shotBytes = png.length;

          const failures = [];
          if (audit.errorBoundary && audit.errorBoundary.present) failures.push(`React 错误边界 #app-error 出现：${audit.errorBoundary.text}`);
          if (row.consoleErrors.length) failures.push(`控制台 error ${row.consoleErrors.length} 条（首条：${row.consoleErrors[0].text.slice(0, 120)}）`);
          if (row.pageErrors.length) failures.push(`未捕获异常 ${row.pageErrors.length} 条（首条：${row.pageErrors[0].text.slice(0, 120)}）`);
          const blocking = cdpPage.blockingRequestFailures;
          if (blocking.length) failures.push(`请求失败 ${blocking.length} 条（首个：${blocking[0].url} — ${blocking[0].errorText}）`);
          if (!audit.root || !audit.root.exists) failures.push("页面没有 #root 容器");
          else if (audit.root.children === 0) failures.push("#root 没有子节点（React 未渲染内容）");
          if (!verdict.implemented) failures.push(verdict.reason);

          row.reason = failures.length ? failures.join("；") : null;
          row.status = failures.length === 0 ? "ok" : verdict.implemented === false && failures.length === 1 ? "missing" : "error";
          row.ok = row.status === "ok" || (allowMissing && row.status === "missing");
          if (!nav || !nav.readyState) row.reason = (row.reason ? row.reason + "；" : "") + "页面 readyState 未知";
        } catch (error) {
          row.ok = false;
          row.status = "error";
          row.reason = formatError(error);
          if (cdpPage) {
            row.consoleErrors = cdpPage.consoleErrors.map((m) => ({ type: m.type, text: m.text }));
            row.pageErrors = cdpPage.pageErrors.map((e) => ({ text: e.text }));
            row.requestFailures = cdpPage.requestFailures.map((f) => ({ url: f.url, errorText: f.errorText }));
            row.httpErrors = cdpPage.httpErrors.map((h) => ({ url: h.url, status: h.status }));
          }
        } finally {
          row.durationMs = Date.now() - started;
          if (cdpPage) {
            try {
              await cdpPage.close();
            } catch {
              /* 忽略关闭失败 */
            }
          }
        }
        pageResults.push(row);
        results.push(row);
        const tag = row.ok ? (row.status === "ok" ? "OK  " : "MISS") : "FAIL";
        log(`  [${tag}] ${row.page} ${width}x${height} ${theme.name} ${row.shot ? `→ ${row.shot} (${row.shotBytes}B)` : "→ 无截图"}${row.reason ? `\n        原因：${row.reason}` : ""}`);
      }
    }
    void pageResults;
  }
} catch (error) {
  fatal = error;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      warn(`关闭 Chrome 时出错：${formatError(error)}`);
    }
  }
}

const failed = results.filter((r) => !r.ok);
const summary = {
  tool: TOOL,
  runId,
  generatedAt: new Date().toISOString(),
  base,
  out: relativeToCwd(outDir),
  pagesSource: source,
  chrome: resolveChromePath(chromePath),
  widths: widthList,
  themes: themeList.map((t) => t.name),
  fullPage,
  reducedMotion,
  allowMissing,
  durationMs: Date.now() - t0,
  totals: {
    combos: results.length,
    ok: results.length - failed.length,
    failed: failed.length,
    missing: results.filter((r) => r.status === "missing").length,
    consoleErrors: results.reduce((n, r) => n + r.consoleErrors.length, 0),
    pageErrors: results.reduce((n, r) => n + r.pageErrors.length, 0),
    requestFailures: results.reduce((n, r) => n + r.requestFailures.length, 0),
  },
  fatal: fatal ? formatError(fatal) : null,
  results,
};

if (!fatal) await writeJson(jsonPath, summary);

log("");
if (fatal) {
  warn(`✗ 致命错误：${formatError(fatal)}`);
  warn(helpForLaunchFailure(fatal));
  process.exit(2);
}
log(`汇总：${summary.totals.ok}/${summary.totals.combos} 组合通过；缺失/未实现 ${summary.totals.missing}；控制台 error ${summary.totals.consoleErrors}；页面异常 ${summary.totals.pageErrors}；请求失败 ${summary.totals.requestFailures}`);
log(`JSON 汇总：${relativeToCwd(jsonPath)}`);
if (failed.length) {
  warn(`✗ ${failed.length} 个组合失败：`);
  for (const r of failed.slice(0, 20)) warn(`  - ${r.page} ${r.width}x${r.height} ${r.theme}：${r.reason}`);
  if (failed.length > 20) warn(`  ...另有 ${failed.length - 20} 个，详见 JSON`);
  process.exit(1);
}
log("✓ 全部组合通过（无控制台 error / 无页面异常 / #root 有内容）");
process.exit(0);

function pageUrlOf(baseUrl, path) {
  if (/^(https?|file):/i.test(path)) return path;
  const b = baseUrl.replace(/\/+$/, "");
  if (path.startsWith("#")) return `${b}/${path}`;
  return `${b}/${path.replace(/^\/+/, "")}`;
}

function helpForLaunchFailure(error) {
  const msg = String((error && error.message) || error);
  if (!/Chrome|调试端口|crashpad|EPERM|OpenProcess/i.test(msg)) return "";
  return [
    "提示：如果错误里出现 crashpad / OpenProcess 拒绝访问 / EPERM 命名管道，说明当前终端处在",
    "受限沙箱内，Chromium 无法启动（不是本工具的问题）。请在未受限的普通 PowerShell 里重跑同一条命令。",
    "诊断：node tools/screenshot.mjs --base <url> --doctor 之外，可直接运行 node tools/cdp.mjs --doctor 看详细探测结果。",
    "参考 frontend/docs/TESTING.md「已知限制」一节。",
  ].join("\n");
}
