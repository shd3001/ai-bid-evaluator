#!/usr/bin/env node
/**
 * selftest.mjs —— 不依赖任何外部服务的一键自测。
 *
 * 做四件事：
 *   1. 在临时目录里生成两页「夹具站点」：一页完全合规，一页故意违规（用于证明检查器真的会报错，而不是橡皮章）。
 *   2. 用 Node 自带 http 起一个静态服务器指向该夹具目录（不需要 vite、不需要网络）。
 *   3. 依次跑 screenshot.mjs 与 a11y-contract.mjs，真实产出 PNG 与 JSON 报告。
 *   4. 断言：PNG 存在且是合法 PNG 魔数、合规页检查通过、违规页被捕获到失败项。
 *
 * 退出码：0=全部通过；1=断言失败（工具/检查逻辑有问题）；2=环境阻断（本终端起不了 Chromium）。
 *
 * 用法：
 *   cd frontend
 *   $env:DSH_NO_NET_USE="1"
 *   & "<node.exe>" tools\selftest.mjs
 *   # 可选：--out <目录>  --chrome <chrome.exe>  --keep  --verbose
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { findFreePort } from "./cdp.mjs";
import { parseCliArgs, argString, argBool, safeName, log, warn, formatError } from "./cli.mjs";
import {
  AUDIT_EXPRESSION,
  ANIMATION_EXPRESSION,
  detectUnimplemented,
  contractChecks,
  a11yChecks,
  levelFails,
} from "./lib/checks.mjs";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(TOOLS_DIR, "..");
const REPO_ROOT = resolve(FRONTEND_DIR, "..");

const { args } = parseCliArgs();
const OUT_DIR = resolve(argString(args, "out", join(REPO_ROOT, ".verification", "selftest")));
const CHROME = argString(args, "chrome", "");
const KEEP = argBool(args, "keep", false);
const VERBOSE = argBool(args, "verbose", false);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok === true ? "[PASS]" : ok === false ? "[FAIL]" : "[SKIP]";
  log(`${tag} ${name}${detail ? ` —— ${detail}` : ""}`);
}

/* ---------------------------------------------------------------- *
 * 1. 夹具站点
 * ---------------------------------------------------------------- */

const GOOD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>夹具 · 合规页</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; }
  .card { border: 1px solid #8884; border-radius: 10px; padding: 16px; max-width: 640px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #22c55e22; }
  .ledger-num { font-variant-numeric: tabular-nums; }
  .tenon--missing { color: #b45309; }
  button:focus-visible, a:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
  @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.02); } }
  .pulse { animation: pulse 2s infinite alternate; }
  @media (prefers-reduced-motion: reduce) {
    .pulse { animation: none; transform: none; }
    * { transition: none !important; }
  }
</style>
</head>
<body>
  <main id="root" class="card">
    <h1>夹具 · 合规页</h1>
    <p>结论徽标：<span class="badge" data-verdict="passed">通过</span></p>
    <p>分值：<span class="ledger-num">87.5</span> / 金额：<span class="ledger-num">¥1,240.00</span></p>
    <p>无证据结论示例：<span class="tenon--missing">缺少证据</span></p>
    <p><button type="button" class="pulse">提交评审</button> <a href="#/projects">返回项目</a></p>
    <p><img src="dot.png" alt="示意圆点" width="16" height="16"></p>
  </main>
</body>
</html>
`;

const BAD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>夹具 · 违规页</title>
<style>
  .box { outline: none; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .spin { animation: spin 1s linear infinite; }
</style>
</head>
<body>
  <div id="root">
    <h1>夹具 · 违规页</h1>
    <p>非法徽标值：<span data-verdict="maybe">存疑</span></p>
    <p>裸分值（未加 .ledger-num）：<span>42.0</span></p>
    <button type="button" class="box"></button>
    <img src="dot.png">
    <div class="spin">转圈</div>
  </div>
</body>
</html>
`;

// 1x1 透明 PNG（合法 PNG，用于 alt 检查与占位资源）
const DOT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9Ue2AAAAAElFTkSuQmCC",
  "base64",
);

/* ---------------------------------------------------------------- *
 * 2. 静态服务器（Node 内置，无需 vite / 网络）
 * ---------------------------------------------------------------- */

const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };

function startStaticServer(rootDir) {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const target = normalize(join(rootDir, rel));
      if (!target.startsWith(rootDir + sep) && target !== rootDir) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const file = existsSync(target) && statSync(target).isFile() ? target : join(rootDir, "index.html");
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end(String(error && error.message));
    }
  });
  return server;
}

/* ---------------------------------------------------------------- *
 * 3. 子进程：把 stdout/stderr 落盘（沙箱下管道 stdio 会 EPERM）
 * ---------------------------------------------------------------- */

function runTool(toolFile, toolArgs, logName) {
  return new Promise((resolvePromise) => {
    const logPath = join(OUT_DIR, logName);
    const fd = openSync(logPath, "a");
    const started = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [toolFile, ...toolArgs], {
        cwd: FRONTEND_DIR,
        env: { ...process.env, DSH_NO_NET_USE: "1" },
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
    } catch (error) {
      closeSync(fd);
      resolvePromise({ code: null, signal: null, logPath, text: String(error && error.message), durationMs: 0, spawnError: true });
      return;
    }
    closeSync(fd);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 240_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const text = readFileSync(logPath, "utf8");
      resolvePromise({ code, signal, logPath, text, durationMs: Date.now() - started });
    });
  });
}

function isPng(filePath) {
  if (!existsSync(filePath)) return false;
  const buf = readFileSync(filePath);
  return buf.length > 100 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

const BLOCKED_RE = /crashpad_client_win\.cc|crash server failed to launch|platform_channel\.cc|EPERM|Access is denied|拒绝访问/;
function looksBlocked(text) {
  return BLOCKED_RE.test(text || "");
}

/* ---------------------------------------------------------------- *
 * 主流程
 * ---------------------------------------------------------------- */

async function main() {
  log("=== dsh 前端截图/a11y 工具自测 ===");
  log(`node ${process.version}`);
  log(`工具目录 ${TOOLS_DIR}`);
  log(`输出目录 ${OUT_DIR}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const fixtureDir = join(OUT_DIR, "fixture");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "index.html"), GOOD_HTML, "utf8");
  writeFileSync(join(fixtureDir, "bad.html"), BAD_HTML, "utf8");
  writeFileSync(join(fixtureDir, "dot.png"), DOT_PNG);
  record("夹具站点已生成", existsSync(join(fixtureDir, "index.html")) && existsSync(join(fixtureDir, "bad.html")), fixtureDir);

  const port = await findFreePort();
  const server = startStaticServer(fixtureDir);
  await new Promise((res, rej) => server.listen(port, "127.0.0.1", (e) => (e ? rej(e) : res())));
  const base = `http://127.0.0.1:${port}`;
  log(`静态服务器 ${base}  (root=${fixtureDir})`);

  try {
    // 服务器自检：两页都能取到
    for (const [path, needle] of [["/", "合规页"], ["/bad.html", "违规页"]]) {
      const response = await fetch(base + path);
      const text = await response.text();
      record(`静态服务器可服务 ${path}`, response.ok && text.includes(needle), `HTTP ${response.status}`);
    }

    // ---- 逻辑自测：不需要浏览器 ----
    log("");
    log("--- 逻辑自测（在 Node 里直接验证注入脚本与判定逻辑，不需要 Chromium）---");
    for (const [name, expr] of [
      ["AUDIT_EXPRESSION", AUDIT_EXPRESSION],
      ["ANIMATION_EXPRESSION", ANIMATION_EXPRESSION],
    ]) {
      try {
        // 只编译不执行：证明注入字符串本身是合法、可自包含求值的表达式（无语法错误、无外部引用）
        new Function(`return (${expr});`);
        record(`${name} 可编译`, true, `${expr.length} 字符`);
      } catch (error) {
        record(`${name} 可编译`, false, String(error && error.message));
      }
    }

    const goodAudit = {
      url: `${base}/`,
      title: "夹具 · 合规页",
      lang: "zh-CN",
      root: { exists: true, children: 3, textLength: 120 },
      errorBoundary: { present: false, text: "" },
      h1: "夹具 · 合规页",
      bodyTextLength: 180,
      bodyTextSample: "夹具 · 合规页 结论徽标 通过 分值 87.5 金额 无证据结论示例 缺少证据 提交评审 返回项目",
      interactive: { total: 2, unreachable: [], hiddenSkipped: 0 },
      styles: { focusVisible: 1, outlineNone: 0, reducedMotionMedia: 1, sheets: 1, totalRules: 20, readErrors: [] },
      images: { total: 1, missingAlt: [], emptyAlt: 0 },
      animations: { supported: true, total: 0, running: 0, runningTransform: 0, names: [] },
      contract: {
        verdicts: { total: 1, counts: { passed: 1 }, values: ["passed"], invalid: [] },
        ledgerNum: { count: 2, sample: ["87.5", "¥1,240.00"] },
        mono: { count: 0, sample: [] },
        tenonMissing: { count: 1, sample: ["缺少证据"] },
        numericLikeWithoutLedgerClass: [],
      },
    };
    const badAudit = {
      url: `${base}/bad.html`,
      title: "夹具 · 违规页",
      lang: "",
      root: { exists: true, children: 6, textLength: 90 },
      errorBoundary: { present: false, text: "" },
      h1: "夹具 · 违规页",
      bodyTextLength: 120,
      bodyTextSample: "夹具 · 违规页 非法徽标值 存疑 裸分值 42.0 转圈",
      interactive: { total: 1, unreachable: ["button.box"], hiddenSkipped: 0 },
      styles: { focusVisible: 0, outlineNone: 1, reducedMotionMedia: 0, sheets: 1, totalRules: 8, readErrors: [] },
      images: { total: 1, missingAlt: ["img[src=dot.png]"], emptyAlt: 0 },
      animations: { supported: true, total: 1, running: 1, runningTransform: 1, names: ["spin"] },
      contract: {
        verdicts: { total: 1, counts: {}, values: ["maybe"], invalid: ["maybe"] },
        ledgerNum: { count: 0, sample: [] },
        mono: { count: 0, sample: [] },
        tenonMissing: { count: 0, sample: [] },
        numericLikeWithoutLedgerClass: ["42.0"],
      },
    };

    const failIds = (audit) =>
      [...a11yChecks(audit, { implemented: true }), ...contractChecks(audit, { implemented: true })]
        .filter((c) => levelFails(c.level))
        .map((c) => c.id);

    const goodFails = failIds(goodAudit);
    const badFails = failIds(badAudit);
    record("判定逻辑：合规审计对象 0 项 FAIL", goodFails.length === 0, goodFails.join(", ") || "0 项");
    record(
      "判定逻辑：违规审计对象被捕获（≥3 项 FAIL，证明检查器不是橡皮章）",
      badFails.length >= 3,
      `${badFails.length} 项：${badFails.join(", ")}`,
    );

    const placeholder = detectUnimplemented({
      root: { exists: true, children: 1 },
      errorBoundary: { present: false },
      h1: null,
      bodyTextLength: 30,
      bodyTextSample: "评审台正在初始化…",
    });
    record("判定逻辑：占位页面被识别为「未实现」", placeholder.implemented === false, placeholder.reason);

    const crashed = detectUnimplemented({
      root: { exists: true, children: 1 },
      errorBoundary: { present: true, text: "boom" },
      h1: null,
      bodyTextLength: 10,
      bodyTextSample: "出错了",
    });
    record("判定逻辑：#app-error 被识别为崩溃", crashed.implemented === true && crashed.crashed === true, crashed.reason);

    // ---- screenshot.mjs ----
    const shotOut = join(OUT_DIR, "shots");
    const shotJson = join(OUT_DIR, "screenshots.json");
    const shotArgs = [
      "--base",
      base,
      "--pages",
      "good=/,bad=/bad.html",
      "--out",
      shotOut,
      "--widths",
      "800,390",
      "--theme",
      "light",
      "--json",
      shotJson,
      "--timeout",
      "30000",
    ];
    if (CHROME) shotArgs.push("--chrome", CHROME);
    log("");
    log(`$ node tools/screenshot.mjs ${shotArgs.join(" ")}`);
    const shot = await runTool(join(TOOLS_DIR, "screenshot.mjs"), shotArgs, "selftest-screenshot.log");
    log(`  → 退出码 ${shot.code}（${shot.durationMs}ms），日志 ${shot.logPath}`);
    if (VERBOSE) log(shot.text);

    const goodShot = join(shotOut, "good-800-light.png");
    const badShot = join(shotOut, "bad-390-light.png");
    if (isPng(goodShot) && isPng(badShot)) {
      record("screenshot.mjs 产出真实 PNG", true, `${goodShot} (${readFileSync(goodShot).length} bytes)`);
    } else if (looksBlocked(shot.text)) {
      record("screenshot.mjs 产出真实 PNG", null, "本终端起不了 Chromium（原因见日志，属环境阻断而非工具缺陷）");
    } else {
      record("screenshot.mjs 产出真实 PNG", false, `未找到合法 PNG；日志：${shot.logPath}`);
    }

    if (existsSync(shotJson)) {
      const report = JSON.parse(readFileSync(shotJson, "utf8"));
      record(
        "screenshots.json 可解析",
        Array.isArray(report.results) || Array.isArray(report.rows) || typeof report.totals === "object",
        `totals=${JSON.stringify(report.totals || {})}`,
      );
    } else {
      record("screenshots.json 可解析", looksBlocked(shot.text) ? null : false, looksBlocked(shot.text) ? "环境阻断，未产出报告" : "报告缺失");
    }

    // ---- a11y-contract.mjs ----
    const a11yOut = join(OUT_DIR, "a11y");
    const a11yJson = join(a11yOut, "a11y-contract.json");
    const a11yArgs = [
      "--base",
      base,
      "--pages",
      "good=/,bad=/bad.html",
      "--out",
      a11yOut,
      "--width",
      "800",
      "--json",
      a11yJson,
    ];
    if (CHROME) a11yArgs.push("--chrome", CHROME);
    log("");
    log(`$ node tools/a11y-contract.mjs ${a11yArgs.join(" ")}`);
    const a11y = await runTool(join(TOOLS_DIR, "a11y-contract.mjs"), a11yArgs, "selftest-a11y.log");
    log(`  → 退出码 ${a11y.code}（${a11y.durationMs}ms），日志 ${a11y.logPath}`);
    if (VERBOSE) log(a11y.text);

    if (existsSync(a11yJson)) {
      const report = JSON.parse(readFileSync(a11yJson, "utf8"));
      const pages = report.pages || report.results || [];
      const good = pages.find((p) => p.name === "good");
      const bad = pages.find((p) => p.name === "bad");
      const failsOf = (page) => (page?.checks || []).filter((c) => c.level === "fail");
      const goodFails = failsOf(good);
      const badFails = failsOf(bad);
      record("合规页无 FAIL 项", good ? goodFails.length === 0 : null, good ? (goodFails.map((c) => c.id).join(", ") || "0 项失败") : "缺少 good 页结果");
      record(
        "违规页被捕获到 FAIL 项（检查器不是橡皮章）",
        bad ? badFails.length >= 3 : null,
        bad ? `捕获 ${badFails.length} 项：${badFails.map((c) => c.id).join(", ")}` : "缺少 bad 页结果",
      );
    } else {
      record("a11y 报告可解析", looksBlocked(a11y.text) ? null : false, looksBlocked(a11y.text) ? "环境阻断，未产出报告" : `报告缺失：${a11yJson}`);
    }
  } finally {
    await new Promise((res) => server.close(res));
    if (!KEEP) {
      // 夹具目录保留（体积可忽略）；仅清理 tmp 里可能的残留
      try {
        const stale = join(tmpdir(), "dsh-selftest-none");
        if (existsSync(stale)) rmSync(stale, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  log("");
  log("=== 汇总 ===");
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  const passed = results.filter((r) => r.ok === true);
  log(`PASS ${passed.length}  FAIL ${failed.length}  SKIP ${skipped.length}`);
  for (const r of failed) warn(`FAIL: ${r.name} —— ${r.detail}`);
  for (const r of skipped) warn(`SKIP: ${r.name} —— ${r.detail}`);

  if (failed.length === 0 && skipped.length === 0) {
    log("SELFTEST: PASS —— 工具链完整，PNG 与报告均为真实产物。");
    return 0;
  }
  if (failed.length === 0 && skipped.length > 0) {
    log("SELFTEST: BLOCKED —— 工具与夹具逻辑已验证；但本终端无法启动 Chromium，PNG 需在未受限终端补齐。");
    return 2;
  }
  log("SELFTEST: FAIL —— 见上面 FAIL 明细。");
  return 1;
}

try {
  const code = await main();
  process.exit(code);
} catch (error) {
  warn(`selftest 崩溃：${formatError(error)}`);
  process.exit(1);
}
