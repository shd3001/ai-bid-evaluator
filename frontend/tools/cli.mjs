/**
 * frontend/tools/cli.mjs
 *
 * 三个 CLI 工具（screenshot / a11y-contract / walkthrough）共用的命令行与输出辅助。
 * 只依赖 Node 内置模块。
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpError, ensureDir } from "./cdp.mjs";

/** frontend/ 目录绝对路径（tools/ 的上一级）。 */
export const FRONTEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 仓库根目录绝对路径。 */
export const REPO_ROOT = resolve(FRONTEND_DIR, "..");

export const TOOLS_DIR = join(FRONTEND_DIR, "tools");
export const PAGES_FILE = join(TOOLS_DIR, "pages.json");

/** 默认验收宽度：桌面 + 移动端。 */
export const DEFAULT_WIDTHS = [1440, 390];

const WIDTH_HEIGHTS = new Map([
  [1920, 1080],
  [1600, 900],
  [1440, 900],
  [1280, 800],
  [1024, 768],
  [834, 1112],
  [768, 1024],
  [430, 932],
  [414, 896],
  [390, 844],
  [375, 812],
]);

export function defaultHeightFor(width) {
  return WIDTH_HEIGHTS.get(Number(width)) ?? 900;
}

/* ------------------------------- 参数解析 ------------------------------- */

/**
 * 极简 --flag / --key value / --key=value 解析。
 * 位置参数收进 positionals。
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = Object.create(null);
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (typeof token === "string" && token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        args[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
        args[body] = true;
      } else {
        args[body] = next;
        index += 1;
      }
    } else if (token !== undefined) {
      positionals.push(token);
    }
  }
  return { args, positionals };
}

export function argString(args, name, fallback = undefined) {
  const value = args[name];
  if (value === undefined) return fallback;
  if (value === true) throw new CdpError(`参数 --${name} 需要一个值`);
  return String(value);
}

export function argBool(args, name, fallback = false) {
  const value = args[name];
  if (value === undefined) return fallback;
  if (value === true) return true;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new CdpError(`参数 --${name} 只接受 true/false，收到：${value}`);
}

export function argNumber(args, name, fallback = undefined) {
  const value = argString(args, name, undefined);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CdpError(`参数 --${name} 需要数字，收到：${value}`);
  return parsed;
}

export function argList(args, name, fallback = undefined, separator = ",") {
  const value = argString(args, name, undefined);
  if (value === undefined) return fallback;
  const items = value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

/* ------------------------------- 页面清单 ------------------------------- */

export function safeName(name) {
  return String(name)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "page";
}

/**
 * --pages "name=#/hash,other=#/other"
 */
export function parsePagesSpec(spec) {
  const pages = [];
  for (const chunk of String(spec).split(",")) {
    const item = chunk.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq === -1) {
      pages.push({ name: safeName(item), path: item, title: item });
      continue;
    }
    const name = safeName(item.slice(0, eq));
    const path = item.slice(eq + 1).trim();
    if (!path) throw new CdpError(`--pages 条目缺少路径：${item}`);
    pages.push({ name, path, title: name });
  }
  if (!pages.length) throw new CdpError(`--pages 解析结果为空：${spec}`);
  return pages;
}

/** 读取 frontend/tools/pages.json。 */
export async function loadPagesFile(pagesFile = PAGES_FILE) {
  let raw;
  try {
    raw = await readFile(pagesFile, "utf8");
  } catch (error) {
    throw new CdpError(`读取页面清单失败：${pagesFile}\n${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CdpError(`页面清单不是合法 JSON：${pagesFile}\n${error.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed.pages;
  if (!Array.isArray(list) || list.length === 0) {
    throw new CdpError(`页面清单里没有 pages 数组：${pagesFile}`);
  }
  const pages = list.map((entry) => {
    const path = entry.path ?? entry.hash ?? entry.url;
    if (!path) throw new CdpError(`页面清单条目缺少 hash/path 字段：${JSON.stringify(entry)}`);
    return {
      name: safeName(entry.name ?? path),
      path: String(path),
      title: entry.title ?? entry.name ?? String(path),
      note: entry.note ?? null,
      needsParam: Boolean(entry.needsParam),
    };
  });
  return { file: pagesFile, defaults: parsed.defaults ?? {}, pages };
}

/**
 * 统一入口：--pages 优先，否则读 pages.json，否则报错。
 * @returns {Promise<{pages: Array, source: string, defaults: object}>}
 */
export async function resolvePages({ pagesSpec, pagesFile = PAGES_FILE } = {}) {
  if (pagesSpec) {
    return { pages: parsePagesSpec(pagesSpec), source: `--pages ${pagesSpec}`, defaults: {} };
  }
  const loaded = await loadPagesFile(pagesFile);
  return { pages: loaded.pages, source: loaded.file, defaults: loaded.defaults };
}

/** 把 base 与页面路径拼成完整 URL（hash 路由、普通路径、绝对 URL 都支持）。 */
export function pageUrl(base, path) {
  if (/^(https?|file):\/\//i.test(path)) return path;
  const trimmedBase = String(base).replace(/\/+$/, "");
  if (path.startsWith("#")) return `${trimmedBase}/${path}`;
  return `${trimmedBase}/${String(path).replace(/^\/+/, "")}`;
}

/* ------------------------------- 输出辅助 ------------------------------- */

export async function writeJson(filePath, value) {
  await ensureDir(dirname(filePath));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

export function relativeToCwd(filePath) {
  const cwd = process.cwd();
  const normalized = resolve(filePath);
  return normalized.toLowerCase().startsWith(cwd.toLowerCase())
    ? normalized.slice(cwd.length).replace(/^[\\/]+/, "")
    : normalized;
}

export function shortUrl(url, limit = 90) {
  if (!url) return "";
  return url.length <= limit ? url : `${url.slice(0, limit - 1)}…`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function generateRunId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes(),
  )}${pad(now.getSeconds())}`;
}

/** 打印一行带前缀的日志。 */
export function log(message) {
  process.stdout.write(`${message}\n`);
}

export function warn(message) {
  process.stderr.write(`${message}\n`);
}

export function printHelp(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** 把异常整理成可读多行文本（含 CdpError.details）。 */
export function formatError(error) {
  if (!error) return "未知错误";
  const parts = [`${error.name ?? "Error"}: ${error.message ?? String(error)}`];
  if (error.details) {
    try {
      parts.push(`  details: ${JSON.stringify(error.details)}`);
    } catch {
      /* ignore */
    }
  }
  if (error.stack && !(error instanceof CdpError)) {
    parts.push(
      error.stack
        .split("\n")
        .slice(1, 4)
        .map((line) => `  ${line.trim()}`)
        .join("\n"),
    );
  }
  return parts.join("\n");
}
