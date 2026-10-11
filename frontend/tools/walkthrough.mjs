#!/usr/bin/env node
/**
 * frontend/tools/walkthrough.mjs
 * 端到端走查：页面清单 → 渲染断言 → 多视口/主题截图 → 无障碍与设计契约审计 → reduced-motion 断言
 * → 汇总成 walkthrough.json + walkthrough.md。
 *
 * 服务器策略（默认自己起，不依赖别人是否已启动）：
 *   默认        用 Node 内置 http 静态托管 frontend/dist（免 vite、免预览端口占用）
 *   --vite-dev  启动 vite dev（127.0.0.1:5173，带 DSH_NO_NET_USE=1 离线补丁）
 *   --vite-preview 启动 vite preview（127.0.0.1:4173）
 *   --base <url> 直接用已有服务器，不再自起
 *
 * 用法：
 *   cd frontend; $env:DSH_NO_NET_USE="1"; & "<node>" tools\walkthrough.mjs
 *   cd frontend; $env:DSH_NO_NET_USE="1"; & "<node>" tools\walkthrough.mjs --base http://127.0.0.1:5173
 *
 * 退出码：0=全部通过；1=有页面失败/控制台 error/契约 FAIL；2=参数或浏览器/服务器启动失败。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import {
  DEFAULT_WIDTHS,
  FRONTEND_DIR,
  PAGES_FILE,
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
import { Browser, CdpError, ensureDir, findFreePort, resolveChromePath, waitForHttp, writePng } from "./cdp.mjs";
import {
  ANIMATION_EXPRESSION,
  AUDIT_EXPRESSION,
  a11yChecks,
  contractChecks,
  detectUnimplemented,
  levelFails,
  summarizeChecks,
} from "./lib/checks.mjs";

const TOOL = "walkthrough";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};
const HELP = [
  "walkthrough.mjs — 端到端走查（CDP，离线，无第三方依赖）",
  "",
  "用法（自己起静态服务器，托管 frontend/dist）：",
  '  cd frontend; $env:DSH_NO_NET_USE="1"; & "C:\\Users\\21910\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe" tools\\walkthrough.mjs',
  "",
  "用法（用已启动的 dev 服务器）：",
  '  cd frontend; & "<node>" tools\\walkthrough.mjs --base http://127.0.0.1:5173',
  "",
  "参数：",
  "  --base <url>       直接用已有服务器（给了就不再自起任何服务器）",
  "  --server <mode>    static（默认，托管 frontend/dist）| vite-dev | vite-preview",
  "  --dist <dir>       static 模式托管的目录（默认 frontend/dist）",
  "  --pages <spec>     name=#/hash 逗号分隔；缺省读取 tools/pages.json",
  "  --pages-file <p>   页面清单文件（默认 tools/pages.json）",
  "  --out <dir>        输出目录（默认 <repo>/.verification/walkthrough）",
  "  --width <n[,n]>    视口宽度，默认 1440,390",
  "  --theme <t[,t]>    主题 light,dark（默认 light,dark）",
  "  --full             整页截图",
  "  --allow-missing    “页面未实现”不计入失败（仍写入报告）",
  "  --chrome <path>    指定 Chrome 可执行文件",
  "  --timeout <ms>     单页超时（默认 30000）",
  "  --port <n>         自起服务器的端口（默认静态服务器随机空闲端口；vite 用 5173/4173）",
  "",
  "产物：",
  "  <out>/walkthrough.json  完整结果（每页断言、截图、控制台错误、契约检查）",
  "  <out>/walkthrough.md    人类可读摘要",
  "  <out>/shots/<name>-<width>-<theme>.png  截图",
];
const { args } = parseCliArgs();
if (argBool(args, "help", false) || argBool(args, "h", false)) {
  printHelp(HELP);
  process.exit(0);
}

const explicitBase = argString(args, "base", null);
const serverMode = String(argString(args, "server", explicitBase ? "external" : "static")).toLowerCase();
const distDir = resolve(process.cwd(), argString(args, "dist", null) || join(FRONTEND_DIR, "dist"));
const outDir = resolve(process.cwd(), argString(args, "out", null) || join(REPO_ROOT, ".verification", "walkthrough"));
const fullPage = argBool(args, "full", false);
const allowMissing = argBool(args, "allow-missing", false) || argBool(args, "allowMissing", false);
const timeoutMs = argNumber(args, "timeout", 30_000);
const chromePath = argString(args, "chrome", null);
const pagesFile = argString(args, "pages-file", null) || argString(args, "pagesFile", null) || PAGES_FILE;
const portArg = argNumber(args, "port", null);
const widthList = (argList(args, "width", null) || argList(args, "widths", null) || DEFAULT_WIDTHS)
  .map(Number)
  .filter((w) => Number.isFinite(w) && w > 0)
  .slice(0, 6);
const themeList = (argList(args, "theme", null) || argList(args, "themes", null) || ["light", "dark"]).map((t) => {
  const v = String(t).trim().toLowerCase();
  if (!["light", "dark"].includes(v)) throw new CdpError(`不支持的主题：${t}（walkthrough 只支持 light/dark）`);
  return v;
});

const { pages, source } = await resolvePages({ pagesSpec: argString(args, "pages", null), pagesFile });
if (!pages.length) {
  warn("页面清单为空：用 --pages 指定，或在 tools/pages.json 里配置");
  process.exit(2);
}

const runId = generateRunId();
const t0 = Date.now();
const shotsDir = join(outDir, "shots");
const jsonPath = resolve(outDir, argString(args, "json", "walkthrough.json"));
const mdPath = resolve(outDir, argString(args, "md", "walkthrough.md"));
let server = null;
let browser = null;
let fatal = null;
const pageReports = [];

try {
  await ensureDir(shotsDir);
  log(`# ${TOOL} 运行 ${runId}`);

  // ---------- 服务器 ----------
  const base = explicitBase || (await startServer(serverMode, distDir, portArg));
  log(`  服务器：${serverMode === "external" ? "外部已有" : serverMode + "（本工具自起）"} → ${base}`);
  log(`  页面来源：${source}（${pages.length} 页）  视口：${widthList.join(", ")}  主题：${themeList.join(", ")}`);

  // 先自检服务器真的能提供页面（这一步不需要浏览器，失败时能立刻区分「服务器没起来」和「浏览器起不来」）
  try {
    const response = await fetch(base + "/");
    const body = await response.text();
    // 注意：body.length 是字符数，UTF-8 页面（中文注释/标题）的字节数更大——对外只说字节数会误导人，两个都报。
    const byteLength = Buffer.byteLength(body, "utf8");
    if (!response.ok || body.trim().length === 0) {
      throw new CdpError(`服务器返回 HTTP ${response.status}，正文 ${byteLength} 字节`);
    }
    log(`  服务器自检：HTTP ${response.status}，首页 ${byteLength} 字节（${body.length} 字符）`);
  } catch (error) {
    log(`  服务器自检失败：${error && error.message ? error.message : error}`);
    server?.close?.();
    server = null;
    throw new CdpError(`静态服务器未就绪，无法继续：${base}\n${error && error.message ? error.message : error}`);
  }

  // ---------- 浏览器 ----------
  browser = await Browser.launch({ chromePath });
  log(`  Chrome：${resolveChromePath(chromePath)}（端口 ${browser.port}${browser.version ? `，${browser.version.Browser}` : ""}）`);
  log(`  输出：${relativeToCwd(outDir)}`);

  for (const page of pages) {
    const started = Date.now();
    const name = safeName(page.name);
    const report = {
      name,
      path: page.path,
      title: page.title,
      note: page.note || null,
      needsParam: !!page.needsParam,
      url: null,
      status: "error",
      ok: false,
      implemented: null,
      implementedReason: null,
      h1: null,
      root: null,
      errorBoundary: null,
      shots: [],
      consoleErrors: [],
      pageErrors: [],
      requestFailures: [],
      httpErrors: [],
      checks: [],
      reducedMotion: null,
      audit: null,
      reasons: [],
      durationMs: 0,
    };

    // 1) 多视口 × 主题截图 + 首个组合顺带做完整审计
    for (const width of widthList) {
      const height = defaultHeightFor(width);
      for (const theme of themeList) {
        const shotPath = join(shotsDir, `${name}-${width}-${theme}.png`);
        let cdpPage = null;
        try {
          cdpPage = await browser.newPage({ width, height, theme, timeoutMs });
          const nav = await cdpPage.goto(urlOf(base, page.path), { timeoutMs });
          report.url = shortUrl(nav.finalUrl || urlOf(base, page.path));
          const audit = await cdpPage.evaluate(AUDIT_EXPRESSION, { timeoutMs });
          if (report.audit === null) report.audit = audit;
          if (report.root === null) report.root = audit.root;
          if (report.h1 === null) report.h1 = audit.h1;
          report.errorBoundary = audit.errorBoundary;
          report.title = audit.title || report.title;
          const verdict = detectUnimplemented(audit);
          report.implemented = verdict.implemented;
          report.implementedReason = verdict.reason || null;
          if (report.checks.length === 0) {
            report.checks = [...a11yChecks(audit, { implemented: verdict.implemented }), ...contractChecks(audit, { implemented: verdict.implemented })];
          }
          const png = await cdpPage.screenshot({ fullPage, timeoutMs });
          await writePng(shotPath, png);
          report.shots.push({ width, height, theme, file: relativeToCwd(shotPath), bytes: png.length, fullPage });
          if (width === widthList[0] && theme === themeList[0]) {
            report.consoleErrors = cdpPage.consoleErrors.map((m) => ({ type: m.type, text: m.text }));
            report.pageErrors = cdpPage.pageErrors.map((e) => ({ text: e.text }));
            report.requestFailures = cdpPage.requestFailures.map((f) => ({ url: f.url, errorText: f.errorText }));
            report.httpErrors = cdpPage.httpErrors.map((h) => ({ url: h.url, status: h.status }));
          }
        } catch (error) {
          report.reasons.push(`${width}x${height} ${theme}：${formatError(error)}`);
          if (cdpPage && report.consoleErrors.length === 0) {
            report.consoleErrors = cdpPage.consoleErrors.map((m) => ({ type: m.type, text: m.text }));
            report.pageErrors = cdpPage.pageErrors.map((e) => ({ text: e.text }));
          }
        } finally {
          if (cdpPage) {
            try {
              await cdpPage.close();
            } catch {
              /* ignore */
            }
          }
        }
      }
    }

    // 2) reduced-motion 断言（模拟 prefers-reduced-motion: reduce 后重新加载）
    let cdpPage = null;
    try {
      const width = widthList[0];
      cdpPage = await browser.newPage({ width, height: defaultHeightFor(width), theme: themeList[0], reducedMotion: true, timeoutMs });
      await cdpPage.goto(urlOf(base, page.path), { timeoutMs });
      const anim = await cdpPage.evaluate(ANIMATION_EXPRESSION, { timeoutMs });
      report.reducedMotion = anim;
      const emulated = await cdpPage.evaluate(`matchMedia("(prefers-reduced-motion: reduce)").matches`, { timeoutMs });
      report.reducedMotion.emulatedMatches = !!emulated;
      if (report.implemented !== false) {
        if (!anim.supported) {
          report.checks.push({ id: "reduced-motion", label: "reduced-motion 下无运行中的 transform 动画", level: "warn", detail: "浏览器不支持 document.getAnimations，无法判定" });
        } else if ((anim.runningTransform || 0) > 0) {
          report.checks.push({ id: "reduced-motion", label: "reduced-motion 下无运行中的 transform 动画", level: "fail", detail: `仍有 ${anim.runningTransform} 个 transform 动画在运行：${JSON.stringify(anim.names)}` });
        } else {
          report.checks.push({ id: "reduced-motion", label: "reduced-motion 下无运行中的 transform 动画", level: "pass", detail: `reduce 模式下运行中的 transform 动画 0 个（总动画 ${anim.total}）` });
        }
      } else {
        report.checks.push({ id: "reduced-motion", label: "reduced-motion 下无运行中的 transform 动画", level: "skipped", detail: "页面尚未实现，断言不适用" });
      }
    } catch (error) {
      report.checks.push({ id: "reduced-motion", label: "reduced-motion 下无运行中的 transform 动画", level: "fail", detail: formatError(error) });
    } finally {
      if (cdpPage) {
        try {
          await cdpPage.close();
        } catch {
          /* ignore */
        }
      }
    }

    // 3) 控制台错误作为失败证据
    if (report.consoleErrors.length || report.pageErrors.length) {
      report.checks.push({
        id: "console-errors",
        label: "控制台无 error / 无未捕获异常",
        level: "fail",
        detail: `${report.consoleErrors.length} 条 console error、${report.pageErrors.length} 条未捕获异常：${JSON.stringify([...report.consoleErrors.slice(0, 3), ...report.pageErrors.slice(0, 2)])}`,
      });
    } else if (report.shots.length) {
      report.checks.push({ id: "console-errors", label: "控制台无 error / 无未捕获异常", level: "pass", detail: "无 console error、无未捕获异常" });
    }

    // 4) 页面级断言
    if (report.root && !report.root.exists) report.reasons.push("页面没有 #root 容器");
    else if (report.root && report.root.children === 0) report.reasons.push("#root 没有子节点（React 未渲染内容）");
    if (report.errorBoundary && report.errorBoundary.present) report.reasons.push(`出现 React 错误边界 #app-error：${report.errorBoundary.text}`);
    if (report.implemented === false && !allowMissing) report.reasons.push(report.implementedReason || "页面尚未实现");
    if (!report.shots.length) report.reasons.push("没有产出任何截图");

    const hasFail = report.checks.some((c) => levelFails(c.level));
    report.status = report.reasons.length === 0 && !hasFail ? "ok" : report.implemented === false ? "missing" : "error";
    report.ok = report.status === "ok" || (allowMissing && report.status === "missing" && !hasFail);
    report.durationMs = Date.now() - started;
    pageReports.push(report);

    const sum = summarizeChecks(report.checks);
    log("");
    log(`${report.ok ? "✓" : "✗"} ${report.name}（${report.path}）→ ${report.status.toUpperCase()}  截图 ${report.shots.length} 张  PASS ${sum.pass}/FAIL ${sum.fail}/WARN ${sum.warn}/SKIP ${sum.skipped}`);
    if (report.url) log(`   ${report.url}`);
    if (report.implemented === false) log(`   未实现：${report.implementedReason}`);
    for (const r of report.reasons) log(`   失败原因：${String(r).split("\n")[0]}`);
    for (const c of report.checks.filter((c) => levelFails(c.level))) log(`   [FAIL] ${c.label} — ${c.detail}`);
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
  if (server) {
    try {
      await server.close();
    } catch (error) {
      warn(`关闭服务器时出错：${formatError(error)}`);
    }
  }
}

const allChecks = pageReports.flatMap((p) => p.checks);
const summary = {
  tool: TOOL,
  runId,
  generatedAt: new Date().toISOString(),
  pagesSource: source,
  serverMode,
  base: server ? server.base : explicitBase,
  out: relativeToCwd(outDir),
  widths: widthList,
  themes: themeList,
  fullPage,
  allowMissing,
  chrome: resolveChromePath(chromePath),
  durationMs: Date.now() - t0,
  totals: {
    pages: pageReports.length,
    ok: pageReports.filter((p) => p.ok).length,
    failed: pageReports.filter((p) => !p.ok).length,
    missing: pageReports.filter((p) => p.implemented === false).length,
    shots: pageReports.reduce((n, p) => n + p.shots.length, 0),
    consoleErrors: pageReports.reduce((n, p) => n + p.consoleErrors.length, 0),
    pageErrors: pageReports.reduce((n, p) => n + p.pageErrors.length, 0),
    checks: summarizeChecks(allChecks),
  },
  fatal: fatal ? formatError(fatal) : null,
  pages: pageReports,
};

if (!fatal) {
  await writeJson(jsonPath, summary);
  await writeMarkdown(mdPath, summary);
  log("");
  log(`汇总：${summary.totals.ok}/${summary.totals.pages} 页通过；未实现 ${summary.totals.missing}；截图 ${summary.totals.shots} 张；控制台 error ${summary.totals.consoleErrors}；页面异常 ${summary.totals.pageErrors}`);
  log(`检查项：PASS ${summary.totals.checks.pass} / FAIL ${summary.totals.checks.fail} / WARN ${summary.totals.checks.warn} / INFO ${summary.totals.checks.info} / SKIP ${summary.totals.checks.skipped}`);
  log(`JSON：${relativeToCwd(jsonPath)}`);
  log(`Markdown：${relativeToCwd(mdPath)}`);
}

if (fatal) {
  warn(`✗ 致命错误：${formatError(fatal)}`);
  warn("提示：若错误含 crashpad / OpenProcess / EPERM，说明当前终端处于受限沙箱，Chromium 无法启动；请在未受限的普通 PowerShell 重跑。参见 docs/TESTING.md。");
  process.exit(2);
}
const failed = pageReports.filter((p) => !p.ok);
if (failed.length) {
  warn(`✗ ${failed.length} 页未通过：${failed.map((p) => `${p.name}(${p.status})`).join(", ")}`);
  process.exit(1);
}
log("✓ 全部页面通过");
process.exit(0);

// ------------------------------------------------------------------ helpers

function urlOf(baseUrl, path) {
  if (/^(https?|file):/i.test(path)) return path;
  const b = baseUrl.replace(/\/+$/, "");
  if (path.startsWith("#")) return `${b}/${path}`;
  return `${b}/${path.replace(/^\/+/, "")}`;
}

async function startServer(mode, dist, port) {
  if (mode === "static") {
    if (!existsSync(join(dist, "index.html"))) {
      throw new CdpError(`静态托管目录里没有 index.html：${dist}\n请先构建（cd frontend; $env:DSH_NO_NET_USE="1"; & "<node>" node_modules\\vite\\bin\\vite.js build），或用 --base 指向已运行的服务器`);
    }
    const handle = await startStaticServer(dist, port);
    server = handle;
    return handle.base;
  }
  if (mode === "vite-dev" || mode === "vite-preview") {
    const viteJs = join(FRONTEND_DIR, "node_modules", "vite", "bin", "vite.js");
    if (!existsSync(viteJs)) throw new CdpError(`找不到 vite：${viteJs}`);
    const vitePort = port || (mode === "vite-dev" ? 5173 : 4173);
    const base = `http://127.0.0.1:${vitePort}`;
    const child = spawn(process.execPath, [viteJs, mode === "vite-dev" ? "dev" : "preview", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, DSH_NO_NET_USE: "1" },
      stdio: "ignore",
      windowsHide: true,
    });
    server = {
      base,
      close: async () => {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          child.kill("SIGTERM");
        }
      },
    };
    await waitForHttp(`${base}/`, { timeoutMs: 90_000, label: `vite ${mode}` });
    return base;
  }
  if (mode === "external") {
    if (!explicitBase) throw new CdpError("--server external 需要同时给 --base");
    await waitForHttp(`${explicitBase.replace(/\/+$/, "")}/`, { timeoutMs: 5_000, label: explicitBase }).catch(() => {
      warn(`警告：${explicitBase} 现在不可达，仍将继续尝试（可能是稍后才起来）`);
    });
    return explicitBase;
  }
  throw new CdpError(`未知 --server 模式：${mode}（可选 static / vite-dev / vite-preview / external）`);
}

async function startStaticServer(root, port) {
  const resolvedRoot = resolve(root);
  const chosen = port || (await findFreePort());
  const httpServer = createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url || "/", `http://127.0.0.1:${chosen}`);
      let rel = decodeURIComponent(parsed.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      let filePath = normalize(join(resolvedRoot, rel));
      if (!filePath.startsWith(resolvedRoot)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("forbidden");
        return;
      }
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        const idx = join(resolvedRoot, "index.html");
        if (!existsSync(idx)) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        filePath = idx;
      }
      const body = await readFile(filePath);
      res.writeHead(200, {
        "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
        "content-length": String(body.length),
        "cache-control": "no-store",
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String((error && error.message) || error));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(chosen, "127.0.0.1", resolveListen);
  });
  return {
    base: `http://127.0.0.1:${chosen}`,
    port: chosen,
    close: () => new Promise((r) => httpServer.close(() => r())),
  };
}

async function writeMarkdown(file, s) {
  const lines = [];
  lines.push(`# 前端走查报告（walkthrough）`);
  lines.push("");
  lines.push(`- 运行 id：\`${s.runId}\`  生成时间：${s.generatedAt}  耗时 ${(s.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- 服务器：${s.serverMode} → ${s.base}  页面来源：${s.pagesSource}`);
  lines.push(`- 视口：${s.widths.join(", ")}　主题：${s.themes.join(", ")}　整页截图：${s.fullPage ? "是" : "否"}`);
  lines.push(`- Chrome：\`${s.chrome}\``);
  lines.push(
    `- 合计：通过 ${s.totals.ok}/${s.totals.pages} 页｜未实现 ${s.totals.missing}｜截图 ${s.totals.shots} 张｜控制台 error ${s.totals.consoleErrors}｜页面异常 ${s.totals.pageErrors}`,
  );
  lines.push(
    `- 检查项：PASS ${s.totals.checks.pass}｜FAIL ${s.totals.checks.fail}｜WARN ${s.totals.checks.warn}｜INFO ${s.totals.checks.info}｜SKIP ${s.totals.checks.skipped}`,
  );
  lines.push("");
  if (s.fatal) {
    lines.push(`> **致命错误**：\`${String(s.fatal).split("\n")[0]}\``);
    lines.push("");
  }
  lines.push("## 逐页结果");
  lines.push("");
  lines.push("| 页面 | 路径 | 状态 | 未实现 | 截图 | PASS | FAIL | WARN | 控制台 error |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of s.pages) {
    const sum = summarizeChecks(p.checks);
    lines.push(
      `| ${p.title || p.name} | \`${p.path}\` | ${p.ok ? "✅" : "❌"} ${p.status} | ${p.implemented === false ? "是" : p.implemented === true ? "否" : "?"} | ${p.shots.length} | ${sum.pass} | ${sum.fail} | ${sum.warn} | ${p.consoleErrors.length} |`,
    );
  }
  lines.push("");
  lines.push("## 断言明细");
  for (const p of s.pages) {
    lines.push("");
    lines.push(`### ${p.title || p.name} — \`${p.path}\``);
    if (p.url) lines.push(`- URL：${p.url}`);
    if (p.implemented === false) lines.push(`- **页面尚未实现**：${p.implementedReason}`);
    if (p.root) lines.push(`- #root：存在=${p.root.exists} 子节点=${p.root.children} 文本长度=${p.root.textLength}`);
    if (p.h1) lines.push(`- h1：${p.h1}`);
    if (p.errorBoundary && p.errorBoundary.present) lines.push(`- **#app-error 错误边界出现**：${p.errorBoundary.text}`);
    for (const r of p.reasons) lines.push(`- 失败原因：${String(r).split("\n")[0]}`);
    for (const c of p.checks) {
      const mark = c.level === "fail" ? "❌" : c.level === "pass" ? "✅" : c.level === "warn" ? "⚠️" : c.level === "skipped" ? "⏭️" : "ℹ️";
      lines.push(`- ${mark} **${c.label}** — ${c.detail}`);
    }
    if (p.shots.length) {
      lines.push(`- 截图：`);
      for (const shot of p.shots) lines.push(`  - [${shot.file}](<${shot.file}>) （${shot.width}x${shot.height} ${shot.theme}${shot.fullPage ? " 整页" : ""}, ${shot.bytes} B）`);
    }
    if (p.consoleErrors.length) {
      lines.push(`- 控制台 error：`);
      for (const e of p.consoleErrors.slice(0, 10)) lines.push(`  - \`${String(e.text).slice(0, 200)}\``);
    }
    if (p.pageErrors.length) {
      lines.push(`- 未捕获异常：`);
      for (const e of p.pageErrors.slice(0, 10)) lines.push(`  - \`${String(e.text).slice(0, 200)}\``);
    }
    if (p.requestFailures.length) {
      lines.push(`- 请求失败：`);
      for (const f of p.requestFailures.slice(0, 10)) lines.push(`  - \`${f.url}\` — ${f.errorText}`);
    }
  }
  const skipped = s.pages.flatMap((p) => p.checks.filter((c) => c.level === "skipped" || c.level === "info").map((c) => `${p.name}：${c.label} — ${c.detail}`));
  lines.push("");
  lines.push("## 未跑成 / 无法自动判定的断言");
  if (!skipped.length) lines.push("- 无");
  for (const line of skipped) lines.push(`- ${line}`);
  lines.push("");
  lines.push("## 证据边界");
  lines.push("");
  lines.push("- 本报告中的**截图**与**无障碍/契约检查**属于**设计验收证据**：它能证明页面渲染出来了、没有控制台错误、交互元素有可达名称、结论徽标取值合法等。");
  lines.push("- 它**不等于功能正确性验收**：不能证明接口返回的业务结论正确、评分算法正确、数据持久化正确。功能验收需要用后端接口测试与人工走查补充。");
  await writeFileText(file, lines.join("\n") + "\n");
}

async function writeFileText(file, text) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, text, "utf8");
}
void loadPagesFile;
void readFileSync;
