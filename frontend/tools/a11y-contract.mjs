#!/usr/bin/env node
/**
 * frontend/tools/a11y-contract.mjs
 * 对每个页面做无障碍 + 设计契约静态审计（在页面里注入脚本求值），输出 JSON 报告与人类可读摘要。
 *
 * 用法：
 *   node tools/a11y-contract.mjs --base http://127.0.0.1:5173 --pages "projects=#/projects" --out .verification/a11y
 *   无 --pages 时读取 tools/pages.json。
 *
 * 退出码：0=无失败；1=有 FAIL 级问题（交互元素无名称 / img 缺 alt / html 缺 lang / 无 :focus-visible / 徽标取值非法 / 控制台 error）；2=参数或浏览器启动失败。
 */
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
import { Browser, CdpError, ensureDir, resolveChromePath } from "./cdp.mjs";
import {
  AUDIT_EXPRESSION,
  a11yChecks,
  contractChecks,
  detectUnimplemented,
  formatChecks,
  levelFails,
  summarizeChecks,
} from "./lib/checks.mjs";

const TOOL = "a11y-contract";
const HELP = [
  "a11y-contract.mjs — 无障碍 + 设计契约审计（CDP，离线）",
  "",
  "用法：",
  '  node tools/a11y-contract.mjs --base http://127.0.0.1:5173 --out ..\\.verification\\a11y [--pages "projects=#/projects"]',
  "",
  "检查项：",
  "  - button/a/input/select/[role=*] 是否有可达名称（可见文本 / aria-label / aria-labelledby / title / label）",
  "  - 是否存在 :focus-visible 规则，以及 outline:none 规则数量",
  "  - img 是否缺 alt、html 是否缺 lang",
  "  - .ledger-num / .mono 命中数量（仅统计）",
  "  - @media (prefers-reduced-motion: reduce) 规则数量",
  "  - 设计契约：[data-verdict] 取值合法性、疑似分值节点是否命中 .ledger-num、.tenon--missing 数量",
  "",
  "参数：",
  "  --base <url>      页面根地址（必填）",
  "  --pages <spec>    name=#/hash 逗号分隔；缺省读取 tools/pages.json",
  "  --pages-file <p>  页面清单文件",
  "  --out <dir>       输出目录（默认 <repo>/.verification/a11y）",
  "  --width <n>       审计视口宽度（默认 1440）",
  "  --height <n>      审计视口高度",
  "  --theme <t>       light | dark | default（默认 default）",
  "  --allow-missing   把“页面未实现”降级为不失败",
  "  --chrome <path>   指定 Chrome 可执行文件",
  "  --timeout <ms>    单页超时（默认 30000）",
  "  --json <file>     报告文件名（默认 a11y-contract.json，写在 --out 下）",
  "  --help            显示本帮助",
];
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

const outDir = resolve(process.cwd(), argString(args, "out", null) || join(REPO_ROOT, ".verification", "a11y"));
const width = argNumber(args, "width", DEFAULT_WIDTHS[0]);
const height = argNumber(args, "height", null) || defaultHeightFor(width);
const themeArg = String(argString(args, "theme", "default")).toLowerCase();
if (!["light", "dark", "default"].includes(themeArg)) throw new CdpError(`不支持的主题：${themeArg}`);
const theme = themeArg === "default" ? null : themeArg;
const allowMissing = argBool(args, "allow-missing", false) || argBool(args, "allowMissing", false);
const timeoutMs = argNumber(args, "timeout", 30_000);
const chromePath = argString(args, "chrome", null);
const pagesFile = argString(args, "pages-file", null) || argString(args, "pagesFile", null);
const jsonPath = resolve(outDir, argString(args, "json", "a11y-contract.json"));
void argList;

const { pages, source } = await resolvePages({ pagesSpec: argString(args, "pages", null), pagesFile });
if (!pages.length) {
  warn("页面清单为空：用 --pages 指定，或在 tools/pages.json 里配置");
  process.exit(2);
}

const runId = generateRunId();
const t0 = Date.now();
let browser = null;
let fatal = null;
const pageReports = [];

try {
  await ensureDir(outDir);
  log(`# ${TOOL} 运行 ${runId}`);
  log(`  页面来源：${source}（${pages.length} 页）  基础地址：${base}  视口 ${width}x${height}  主题 ${themeArg}`);
  log(`  输出：${relativeToCwd(outDir)}`);

  browser = await Browser.launch({ chromePath });
  log(`  Chrome 已就绪：${browser.version ? browser.version.Browser : "(版本未知)"}  端口 ${browser.port}`);

  for (const page of pages) {
    const started = Date.now();
    let cdpPage = null;
    const report = {
      name: safeName(page.name),
      path: page.path,
      title: page.title,
      needsParam: !!page.needsParam,
      url: null,
      ok: false,
      implemented: null,
      implementedReason: null,
      checks: [],
      consoleErrors: [],
      pageErrors: [],
      audit: null,
      error: null,
      durationMs: 0,
    };
    try {
      cdpPage = await browser.newPage({ width, height, theme, timeoutMs });
      const nav = await cdpPage.goto(urlOf(base, page.path), { timeoutMs });
      report.url = shortUrl(nav.finalUrl || urlOf(base, page.path));
      report.consoleErrors = cdpPage.consoleErrors.map((m) => ({ type: m.type, text: m.text }));
      report.pageErrors = cdpPage.pageErrors.map((e) => ({ text: e.text }));
      const audit = await cdpPage.evaluate(AUDIT_EXPRESSION, { timeoutMs });
      report.audit = audit;
      report.title = audit.title || report.title;
      const verdict = detectUnimplemented(audit);
      report.implemented = verdict.implemented;
      report.implementedReason = verdict.reason || null;
      report.implementedCrashed = !!verdict.crashed;
      report.checks = [...a11yChecks(audit, { implemented: verdict.implemented }), ...contractChecks(audit, { implemented: verdict.implemented })];
      if (report.consoleErrors.length) {
        report.checks.push({ id: "console-errors", label: "控制台无 error", level: "fail", detail: `${report.consoleErrors.length} 条：${JSON.stringify(report.consoleErrors.slice(0, 4))}` });
      } else {
        report.checks.push({ id: "console-errors", label: "控制台无 error", level: "pass", detail: "无 console error" });
      }
      report.ok = !report.checks.some((c) => levelFails(c.level)) && (verdict.implemented || allowMissing);
      if (!verdict.implemented && !allowMissing) report.ok = false;
    } catch (error) {
      report.ok = false;
      report.error = formatError(error);
      if (cdpPage) {
        report.consoleErrors = cdpPage.consoleErrors.map((m) => ({ type: m.type, text: m.text }));
        report.pageErrors = cdpPage.pageErrors.map((e) => ({ text: e.text }));
      }
    } finally {
      report.durationMs = Date.now() - started;
      if (cdpPage) {
        try {
          await cdpPage.close();
        } catch {
          /* ignore */
        }
      }
    }
    pageReports.push(report);

    const sum = summarizeChecks(report.checks);
    log("");
    log(`## ${report.name}（${report.path}）${report.ok ? "" : "  ✗"}`);
    if (report.url) log(`   ${report.url}`);
    if (report.implemented === false) log(`   页面状态：尚未实现 —— ${report.implementedReason}`);
    if (report.error) log(`   审计失败：${report.error.split("\n")[0]}`);
    for (const line of formatChecks(report.checks)) log(line);
    if (report.audit) {
      const a = report.audit;
      log(
        `   统计：交互元素 ${a.interactive.total}（无名称 ${a.interactive.unreachable.length}，隐藏跳过 ${a.interactive.hiddenSkipped}）｜img ${a.images.total}（缺 alt ${a.images.missingAlt.length}）｜lang=${a.lang}｜:focus-visible ${a.styles.focusVisible}｜outline:none ${a.styles.outlineNone}｜reduced-motion 媒体查询 ${a.styles.reducedMotionMedia}｜.ledger-num ${a.contract.ledgerNum.count}｜.mono ${a.contract.mono.count}｜[data-verdict] ${a.contract.verdicts.total}｜.tenon--missing ${a.contract.tenonMissing.count}`,
      );
    }
    log(`   PASS ${sum.pass} / FAIL ${sum.fail} / WARN ${sum.warn} / INFO ${sum.info} / SKIP ${sum.skipped}`);
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

const allChecks = pageReports.flatMap((p) => p.checks);
const report = {
  tool: TOOL,
  runId,
  generatedAt: new Date().toISOString(),
  base,
  out: relativeToCwd(outDir),
  viewport: { width, height },
  theme: themeArg,
  allowMissing,
  chrome: resolveChromePath(chromePath),
  durationMs: Date.now() - t0,
  totals: {
    pages: pageReports.length,
    ok: pageReports.filter((p) => p.ok).length,
    failed: pageReports.filter((p) => !p.ok).length,
    implemented: pageReports.filter((p) => p.implemented === true).length,
    missing: pageReports.filter((p) => p.implemented === false).length,
    checks: summarizeChecks(allChecks),
  },
  fatal: fatal ? formatError(fatal) : null,
  pages: pageReports,
};
if (!fatal) {
  await writeJson(jsonPath, report);
  log("");
  log(`汇总：${report.totals.ok}/${report.totals.pages} 页通过；已实现 ${report.totals.implemented}；未实现 ${report.totals.missing}`);
  log(`检查项合计：PASS ${report.totals.checks.pass} / FAIL ${report.totals.checks.fail} / WARN ${report.totals.checks.warn} / INFO ${report.totals.checks.info} / SKIP ${report.totals.checks.skipped}`);
  log(`JSON 报告：${relativeToCwd(jsonPath)}`);
}

if (fatal) {
  warn(`✗ 致命错误：${formatError(fatal)}`);
  warn("提示：若错误含 crashpad / OpenProcess / EPERM，说明当前终端处于受限沙箱，Chromium 无法启动；请在未受限的普通 PowerShell 重跑。参见 docs/TESTING.md。");
  process.exit(2);
}
const failed = pageReports.filter((p) => !p.ok);
if (failed.length) {
  warn(`✗ ${failed.length} 页未通过：${failed.map((p) => p.name).join(", ")}`);
  for (const p of failed) {
    if (p.error) warn(`  - ${p.name}：${p.error.split("\n")[0]}`);
    for (const c of p.checks.filter((c) => levelFails(c.level))) warn(`  - ${p.name}：[${c.id}] ${c.detail}`);
    if (p.implemented === false) warn(`  - ${p.name}：页面尚未实现（${p.implementedReason}）`);
  }
  process.exit(1);
}
log("✓ 无障碍与设计契约检查全部通过");
process.exit(0);

function urlOf(baseUrl, path) {
  if (/^(https?|file):/i.test(path)) return path;
  const b = baseUrl.replace(/\/+$/, "");
  if (path.startsWith("#")) return `${b}/${path}`;
  return `${b}/${path.replace(/^\/+/, "")}`;
}
