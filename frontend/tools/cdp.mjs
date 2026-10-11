/**
 * frontend/tools/cdp.mjs
 *
 * 零依赖 Chrome DevTools Protocol (CDP) 客户端 —— 离线截图 / 走查工具的可复用底座。
 *
 * 约束（本仓库离线环境实测）：
 *   - 只用 Node 内置模块（node:child_process / node:fs / node:net）+ Node 24 自带的全局 WebSocket，不装 ws/playwright/selenium。
 *   - 起 Chrome 时 stdio 必须用 "ignore" 或重定向到文件；DSH 沙箱下用管道捕捉子进程输出会 EPERM。
 *   - Chrome 的 user-data-dir 默认落在系统临时目录 %TEMP%\dsh-cdp-profile\run-* 下（成功退出时自动删除，
 *     不污染工作区）；启动失败时会保留该目录，方便查看里面的 chrome-stderr.log。可用 userDataDir 覆盖。
 *
 * 主要导出：
 *   CdpError, sleep, ensureDir, writePng, resolveChromePath, findFreePort, waitForHttp
 *   CdpConnection  —— 单条 WebSocket 上的命令/事件多路复用
 *   Browser        —— 启动 Chrome + 打开页面 + 关闭清理
 *   CdpPage        —— 页面级封装：导航、等待、evaluate、截图、console/network 采集
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 主题注入时同时写入的 localStorage 键名（页面实现可能用其中任意一个）。
 * 第一个是本应用的真实键（`frontend/src/utils/theme.ts` 的 `STORAGE_KEY`）——必须命中它，
 * 否则应用启动时的 `initTheme()` 读不到选择、会按 `prefers-color-scheme` 重写 `<html data-theme>`，
 * 把注入的深色"改回"系统主题。其余键只是兼容其它实现的兜底。
 */
export const DEFAULT_THEME_KEYS = ["review-desk.theme.v1", "theme", "dsh-theme", "app-theme"];

export class CdpError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "CdpError";
    this.details = details;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writePng(filePath, buffer) {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, buffer);
  return filePath;
}

/** 读取文本文件末尾若干行（Chrome 启动日志诊断用，文件不存在或缺读时返回 ""）。 */
export function readTail(filePath, maxLines = 25) {
  try {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

/**
 * 把 Chrome 的启动日志翻成一句人话。
 * 本仓库实测：受限沙箱下 Chrome 必然在这里自杀（crashpad 拿不到 handler 句柄 + 命名管道被拒）。
 */
export function diagnoseChromeLog(logText) {
  const text = String(logText || "");
  if (!text) return "";
  if (/crashpad_client_win\.cc/.test(text) || /crash server failed to launch/.test(text)) {
    return [
      "诊断：Chrome 的 crashpad 客户端无法启动崩溃处理器（OpenProcess 被拒绝），按设计自杀。",
      "      这不是本工具的参数问题，而是当前终端所在沙箱同时禁用了 OpenProcess 与命名管道。",
      "      请在未受限的普通 PowerShell/终端里重跑同一条命令。",
    ].join("\n");
  }
  if (/platform_channel\.cc/.test(text) && /拒绝访问|Access is denied|0x5/.test(text)) {
    return [
      "诊断：Chromium 的 Mojo 命名管道创建/打开被拒绝 —— 沙箱禁止命名管道，多进程 Chromium 无法工作。",
      "      请在未受限的普通 PowerShell/终端里重跑同一条命令。",
    ].join("\n");
  }
  if (/Access is denied|拒绝访问/.test(text)) {
    return "诊断：日志里出现「拒绝访问 / Access is denied」，多半是沙箱权限限制；请在未受限终端重跑。";
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * 小工具：路径 / 端口 / HTTP 轮询
 * ------------------------------------------------------------------ */

export function chromeCandidates() {
  const env = process.env.CHROME_PATH || process.env.CHROME_BIN;
  return [
    env,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
}

export function resolveChromePath(explicit) {
  const list = explicit ? [explicit] : chromeCandidates();
  for (const candidate of list) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new CdpError(
    "找不到 Chrome/Edge 可执行文件。请用 --chrome <path> 指定，或设置 CHROME_PATH 环境变量。已尝试：\n  " +
      list.join("\n  "),
  );
}

export async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new CdpError("无法分配空闲端口"))));
    });
  });
}

async function httpProbe(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** 轮询一个 URL 直到返回任意 HTTP 响应（服务器就绪）。 */
export async function waitForHttp(url, { timeoutMs = 60_000, intervalMs = 250, label = url } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await httpProbe(url, 3000);
      if (response.status < 500) return { status: response.status, waitedMs: Date.now() - startedAt };
      lastError = new CdpError(`${url} 返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new CdpError(
    `等待 ${label} 就绪超时(${timeoutMs}ms)。最后一次错误：${lastError ? lastError.message : "无"}`,
  );
}

/* ------------------------------------------------------------------ *
 * CdpConnection：一条 WebSocket 上的命令/事件多路复用
 * ------------------------------------------------------------------ */

export class CdpConnection {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();
  #closedReason = null;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => this.#onMessage(event.data));
    ws.addEventListener("close", (event) => this.#onClose(event));
    // 必须挂一个长期 error 监听，否则连接中断会以 unhandled error 事件冒泡。
    ws.addEventListener("error", () => {});
  }

  get closed() {
    return this.#closedReason !== null;
  }

  get closedReason() {
    return this.#closedReason;
  }

  static async connect(wsUrl, { timeoutMs = 15_000 } = {}) {
    if (typeof WebSocket !== "function") {
      throw new CdpError(
        `当前 Node (${process.version}) 没有全局 WebSocket。需要 Node >= 22，或改用 .venv311 的 websockets 方案。`,
      );
    }
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new CdpError(`连接 CDP WebSocket 超时(${timeoutMs}ms)：${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        (event) => {
          clearTimeout(timer);
          const detail = event && event.message ? event.message : "WebSocket error";
          reject(new CdpError(`连接 CDP WebSocket 失败：${wsUrl} (${detail})`));
        },
        { once: true },
      );
    });
    return new CdpConnection(ws);
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (typeof message.id === "number" && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const extra = message.error.data ? ` (${message.error.data})` : "";
        pending.reject(new CdpError(`CDP 命令失败 ${pending.method}：${message.error.message}${extra}`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) this.#emit(message.method, message.params ?? {}, message.sessionId);
  }

  #onClose(event) {
    const reason = `WebSocket 已关闭 (code=${event?.code ?? "?"}${event?.reason ? `, reason=${event.reason}` : ""})`;
    this.#closedReason = reason;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError(`${reason}；未完成的命令：${pending.method}`));
    }
    this.#pending.clear();
    this.#emit("__closed", { reason }, undefined);
  }

  #emit(event, params, sessionId) {
    const handlers = this.#listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(params, sessionId);
      } catch {
        /* 采集器不允许打断协议循环 */
      }
    }
  }

  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => {
      this.#listeners.get(event)?.delete(handler);
    };
  }

  waitForEvent(event, { sessionId = undefined, timeoutMs = DEFAULT_TIMEOUT_MS, predicate = undefined } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const off = this.on(event, (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        if (predicate && !predicate(params, sid)) return;
        if (timer) clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        off();
        reject(new CdpError(`等待 CDP 事件超时(${timeoutMs}ms)：${event}`));
      }, timeoutMs);
    });
  }

  send(method, params = {}, { sessionId = undefined, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closed) {
      return Promise.reject(new CdpError(`CDP 连接不可用（${this.#closedReason}），无法发送 ${method}`));
    }
    const id = ++this.#nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`CDP 命令超时(${timeoutMs}ms)：${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError(`发送 CDP 命令失败 ${method}：${error.message}`));
      }
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Browser：启动 Chrome → 连接 CDP → 开关页面
 * ------------------------------------------------------------------ */

function describeRemoteObject(object) {
  if (!object) return "?";
  if (object.value !== undefined) {
    return typeof object.value === "string" ? object.value : JSON.stringify(object.value);
  }
  if (object.unserializableValue !== undefined) return String(object.unserializableValue);
  return object.description ?? object.type ?? "?";
}

const FAVICON_RE = /\/favicon\.ico(\?|$)/i;

export class Browser {
  constructor({ child, connection, chromePath, port, profileDir, keepProfile, chromeLogPath = null }) {
    this.child = child;
    this.connection = connection;
    this.chromePath = chromePath;
    this.port = port;
    this.profileDir = profileDir;
    this.keepProfile = keepProfile;
    this.chromeLogPath = chromeLogPath;
    this.pages = new Set();
    this.#exitHook = () => {
      try {
        if (child.exitCode === null && child.pid) process.kill(child.pid);
      } catch {
        /* best effort */
      }
    };
    process.once("exit", this.#exitHook);
  }

  #exitHook;

  static async launch({
    chromePath = undefined,
    port = undefined,
    headless = true,
    userDataDir = undefined,
    extraArgs = [],
    startupTimeoutMs = 30_000,
    keepProfile = false,
  } = {}) {
    const resolvedChrome = resolveChromePath(chromePath);
    const resolvedPort = port ?? (await findFreePort());
    const profileDir =
      userDataDir ??
      join(tmpdir(), "dsh-cdp-profile", `run-${Date.now()}-${process.pid}`);
    await ensureDir(profileDir);

    const args = [
      ...(headless ? ["--headless=new"] : []),
      `--remote-debugging-port=${resolvedPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--mute-audio",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--window-size=1440,900",
      // 把 Chrome 自己的启动日志写到 stderr；stdout 丢弃。日志重定向到 <profile>/chrome-stderr.log，
      // 这样启动失败时能拿到崩溃原因原文（例如 crashpad / OpenProcess 拒绝访问），而不是只有 exitCode。
      "--enable-logging=stderr",
      ...extraArgs,
      "about:blank",
    ];

    const chromeLogPath = join(profileDir, "chrome-stderr.log");
    let logFd = null;
    try {
      logFd = openSync(chromeLogPath, "a");
    } catch {
      logFd = null;
    }

    let child;
    try {
      // stdio: 管道捕捉子进程输出在受限沙箱下会 EPERM，所以 stdout 丢弃、stderr 重定向到文件 fd。
      child = spawn(resolvedChrome, args, {
        stdio: ["ignore", "ignore", logFd ?? "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      throw new CdpError(`启动 Chrome 失败：${resolvedChrome}\n${error.message}`);
    } finally {
      // 父进程不需要保留 fd 副本（子进程已继承）。
      if (logFd !== null) {
        try {
          closeSync(logFd);
        } catch {
          /* ignore */
        }
      }
    }
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new CdpError(`启动 Chrome 进程失败：${error.message}`)));
    });

    const probeUrl = `http://127.0.0.1:${resolvedPort}/json/version`;
    const startedAt = Date.now();
    let version = null;
    let lastError = null;
    while (Date.now() - startedAt < startupTimeoutMs) {
      if (child.exitCode !== null) {
        const logTail = readTail(chromeLogPath, 25);
        throw new CdpError(
          `Chrome 在调试端口就绪前退出（exitCode=${child.exitCode}）。命令行：\n${resolvedChrome} ${args.join(" ")}` +
            `\nChrome stderr（${chromeLogPath}）末尾：\n${logTail || "(无输出)"}` +
            `\n${diagnoseChromeLog(logTail)}`,
          { chromeLogPath, exitCode: child.exitCode },
        );
      }
      try {
        const response = await httpProbe(probeUrl, 2000);
        if (response.ok) {
          version = await response.json();
          break;
        }
        lastError = new CdpError(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await sleep(150);
    }
    if (!version?.webSocketDebuggerUrl) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      const logTail = readTail(chromeLogPath, 25);
      throw new CdpError(
        `等待 Chrome 调试端口超时(${startupTimeoutMs}ms)：${probeUrl}\n最后一次错误：${
          lastError ? lastError.message : "无"
        }\nChrome stderr（${chromeLogPath}）末尾：\n${logTail || "(无输出)"}`,
        { chromeLogPath },
      );
    }

    let connection;
    try {
      connection = await CdpConnection.connect(version.webSocketDebuggerUrl);
    } catch (error) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      throw new CdpError(`连接 Chrome CDP 失败（${version.webSocketDebuggerUrl}）：${error.message}`);
    }

    const browser = new Browser({
      child,
      connection,
      chromePath: resolvedChrome,
      port: resolvedPort,
      profileDir,
      keepProfile,
      chromeLogPath,
    });
    browser.version = version;
    return browser;
  }

  get browserWsUrl() {
    return this.version?.webSocketDebuggerUrl ?? null;
  }

  async newPage(options = {}) {
    const {
      width = 1440,
      height = 900,
      mobile = undefined,
      deviceScaleFactor = 1,
      theme = null,
      themeKeys = DEFAULT_THEME_KEYS,
      reducedMotion = null,
      url = null,
      waitForLoad = true,
      timeoutMs = 30_000,
    } = options;

    let targetId;
    try {
      ({ targetId } = await this.connection.send("Target.createTarget", { url: "about:blank" }));
    } catch (error) {
      throw new CdpError(`创建标签页失败：${error.message}`);
    }

    let sessionId;
    try {
      ({ sessionId } = await this.connection.send("Target.attachToTarget", { targetId, flatten: true }));
    } catch (error) {
      await this.connection.send("Target.closeTarget", { targetId }).catch(() => {});
      throw new CdpError(`附加到标签页失败(targetId=${targetId})：${error.message}`);
    }

    const page = new CdpPage(this, {
      targetId,
      sessionId,
      width,
      height,
      isMobile: mobile ?? width <= 500,
      deviceScaleFactor,
    });
    this.pages.add(page);
    try {
      await page.init({ theme, themeKeys, reducedMotion, timeoutMs });
      if (url) await page.goto(url, { timeoutMs, waitForLoad });
    } catch (error) {
      await page.close().catch(() => {});
      this.pages.delete(page);
      throw error;
    }
    return page;
  }

  async close() {
    for (const page of [...this.pages]) {
      await page.close().catch(() => {});
    }
    this.pages.clear();

    try {
      await this.connection.send("Browser.close", {}, { timeoutMs: 4000 });
    } catch {
      /* 浏览器可能已经自行退出 */
    }
    this.connection.close();

    const deadline = Date.now() + 5000;
    while (this.child.exitCode === null && Date.now() < deadline) await sleep(100);

    if (this.child.exitCode === null && this.child.pid) {
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          // stdio: "ignore" —— 同上，避免沙箱 EPERM。
          const killer = spawn("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.once("exit", resolve);
          killer.once("error", resolve);
        });
      } else {
        try {
          this.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      await sleep(300);
    }

    process.removeListener("exit", this.#exitHook);

    if (!this.keepProfile && this.profileDir) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await rm(this.profileDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(250);
        }
      }
      if (existsSync(this.profileDir)) {
        process.stderr.write(`[cdp] 警告：未能完全删除临时 profile 目录 ${this.profileDir}（可手动删除）\n`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * CdpPage：页面级封装
 * ------------------------------------------------------------------ */

export class CdpPage {
  constructor(browser, { targetId, sessionId, width, height, isMobile, deviceScaleFactor }) {
    this.browser = browser;
    this.connection = browser.connection;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.width = width;
    this.height = height;
    this.isMobile = isMobile;
    this.deviceScaleFactor = deviceScaleFactor;

    this.consoleMessages = [];
    this.consoleErrors = [];
    this.pageErrors = [];
    this.requestFailures = [];
    this.httpErrors = [];
    this.browserLogs = [];
    this.networkIdle = null;
    this.readyState = null;
    this.finalUrl = null;
    this.title = null;
    this.lastScreenshot = null;

    this.#inflight = new Map();
    this.#requestUrls = new Map();
    this.#offs = [];
  }

  #inflight;
  #requestUrls;
  #offs;
  #closed = false;

  #send(method, params = {}, timeoutMs = undefined) {
    return this.connection.send(method, params, {
      sessionId: this.sessionId,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async init({ theme = null, themeKeys = DEFAULT_THEME_KEYS, reducedMotion = null, timeoutMs = 20_000 } = {}) {
    await Promise.all([
      this.#send("Page.enable", {}, timeoutMs),
      this.#send("Runtime.enable", {}, timeoutMs),
      this.#send("Network.enable", {}, timeoutMs),
      this.#send("Log.enable", {}, timeoutMs),
    ]);
    this.#installCollectors();
    await this.setViewport({ width: this.width, height: this.height, isMobile: this.isMobile });
    if (reducedMotion !== null) await this.setReducedMotion(reducedMotion);
    if (theme) await this.applyTheme(theme, themeKeys);
    await this.#send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});
  }

  #installCollectors() {
    const { connection, sessionId } = this;
    const mine = (sid) => sid === sessionId;

    this.#offs.push(
      connection.on("Runtime.consoleAPICalled", (params, sid) => {
        if (!mine(sid)) return;
        const entry = {
          type: params.type,
          text: (params.args ?? []).map(describeRemoteObject).join(" "),
          at: new Date().toISOString(),
        };
        if (this.consoleMessages.length < 300) this.consoleMessages.push(entry);
        if (params.type === "error" || params.type === "assert") this.consoleErrors.push(entry);
      }),
    );

    this.#offs.push(
      connection.on("Runtime.exceptionThrown", (params, sid) => {
        if (!mine(sid)) return;
        const details = params.exceptionDetails ?? {};
        this.pageErrors.push({
          text: details.text ?? "uncaught exception",
          description: details.exception?.description ?? null,
          url: details.url ?? null,
          line: details.lineNumber ?? null,
          column: details.columnNumber ?? null,
          at: new Date().toISOString(),
        });
      }),
    );

    this.#offs.push(
      connection.on("Network.requestWillBeSent", (params, sid) => {
        if (!mine(sid)) return;
        const url = params.request?.url ?? "";
        this.#inflight.set(params.requestId, url);
        if (this.#requestUrls.size < 800) this.#requestUrls.set(params.requestId, url);
      }),
    );

    this.#offs.push(
      connection.on("Network.webSocketCreated", (params, sid) => {
        if (!mine(sid)) return;
        // WebSocket 升级请求不会走 loadingFinished，必须手动出队，否则 networkIdle 永远不成立。
        this.#inflight.delete(params.requestId);
      }),
    );

    this.#offs.push(
      connection.on("Network.responseReceived", (params, sid) => {
        if (!mine(sid)) return;
        const status = params.response?.status ?? 0;
        const url = params.response?.url ?? this.#requestUrls.get(params.requestId) ?? "";
        if (status >= 400 && !FAVICON_RE.test(url)) {
          this.httpErrors.push({ url, status, statusText: params.response?.statusText ?? "", type: params.type });
        }
      }),
    );

    const dequeue = (params, sid) => {
      if (!mine(sid)) return;
      this.#inflight.delete(params.requestId);
    };
    this.#offs.push(connection.on("Network.loadingFinished", dequeue));

    this.#offs.push(
      connection.on("Network.loadingFailed", (params, sid) => {
        if (!mine(sid)) return;
        this.#inflight.delete(params.requestId);
        const url = this.#requestUrls.get(params.requestId) ?? "";
        const failure = {
          url,
          errorText: params.errorText ?? "unknown",
          type: params.type ?? null,
          canceled: Boolean(params.canceled),
          blockedReason: params.blockedReason ?? null,
        };
        // cancel 是页面主动中止（路由切换 / 组件卸载），不算契约失败，但保留证据。
        this.requestFailures.push(failure);
      }),
    );

    this.#offs.push(
      connection.on("Log.entryAdded", (params, sid) => {
        if (!mine(sid)) return;
        const entry = params.entry ?? {};
        if (this.browserLogs.length >= 200) return;
        this.browserLogs.push({
          source: entry.source ?? "unknown",
          level: entry.level ?? "unknown",
          text: entry.text ?? "",
          url: entry.url ?? null,
        });
      }),
    );

    this.#offs.push(
      connection.on("Page.javascriptDialogOpening", (_params, sid) => {
        if (!mine(sid)) return;
        // 自动关闭弹窗，避免走查被 alert/confirm 卡死。
        this.#send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }),
    );

    this.#offs.push(
      connection.on("Page.frameNavigated", (params, sid) => {
        if (!mine(sid)) return;
        if (!params.frame?.parentId) this.finalUrl = params.frame?.url ?? this.finalUrl;
      }),
    );
  }

  async setViewport({ width, height, isMobile = undefined, deviceScaleFactor = undefined }) {
    if (width) this.width = width;
    if (height) this.height = height;
    if (isMobile !== undefined) this.isMobile = isMobile;
    if (deviceScaleFactor) this.deviceScaleFactor = deviceScaleFactor;
    await this.#send("Emulation.setDeviceMetricsOverride", {
      width: this.width,
      height: this.height,
      deviceScaleFactor: this.deviceScaleFactor,
      mobile: this.isMobile,
      screenWidth: this.width,
      screenHeight: this.height,
    });
    if (this.isMobile) {
      await this.#send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }).catch(() => {});
    }
    return this;
  }

  async setReducedMotion(enabled) {
    await this.#send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: enabled ? "reduce" : "no-preference" }],
    });
  }

  /**
   * 设置主题：既写 localStorage 与 documentElement.dataset.theme（当前文档），
   * 也注册 new-document 脚本（后续导航在应用启动前生效）。
   *
   * 刻意**不**用 `Emulation.setEmulatedMedia` 模拟 `prefers-color-scheme`：该命令的 `features`
   * 是整体覆盖的，会顺手抹掉 `setReducedMotion` 设的 `prefers-reduced-motion`（`--theme` 与
   * `--reduced-motion` 同时用时就会互相打架）。改为写真实存储键，让应用自己解析出 `light|dark`。
   */
  async applyTheme(theme, keys = DEFAULT_THEME_KEYS) {
    const expression = `(() => {
      const theme = ${JSON.stringify(theme)};
      const keys = ${JSON.stringify(keys)};
      const apply = () => {
        try {
          for (const key of keys) { try { localStorage.setItem(key, theme); } catch (e) {} }
          const root = document.documentElement;
          if (root) { root.dataset.theme = theme; root.style.colorScheme = theme; }
        } catch (e) {}
      };
      apply();
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
    })()`;
    try {
      await this.#send("Page.addScriptToEvaluateOnNewDocument", { source: expression });
    } catch {
      /* 老版本 Chrome 可能不支持，退化为仅当前文档 */
    }
    await this.evaluate(expression).catch(() => {});
    return this;
  }

  async goto(
    url,
    {
      timeoutMs = 30_000,
      waitForLoad = true,
      idleMs = 500,
      idleTimeoutMs = 15_000,
      settleMs = 600,
      waitUntilReady = true,
    } = {},
  ) {
    this.consoleErrors.length = 0;
    this.pageErrors.length = 0;
    this.requestFailures.length = 0;
    this.httpErrors.length = 0;
    this.browserLogs.length = 0;
    this.consoleMessages.length = 0;

    const loadWaiter = this.connection.waitForEvent("Page.loadEventFired", {
      sessionId: this.sessionId,
      timeoutMs,
    });
    loadWaiter.catch(() => {}); // 避免未处理的 rejection

    let result;
    try {
      result = await this.#send("Page.navigate", { url }, timeoutMs);
    } catch (error) {
      throw new CdpError(`导航失败 (${url})：${error.message}`);
    }
    if (result?.errorText) {
      throw new CdpError(`浏览器拒绝加载 ${url}：${result.errorText}`);
    }

    let loadFired = false;
    if (waitForLoad) {
      try {
        await loadWaiter;
        loadFired = true;
      } catch {
        loadFired = false; // 纯 hash 导航不会触发 loadEventFired，交给 readyState 兜底
      }
    }

    if (waitUntilReady) {
      await this.waitUntilReady({ timeoutMs, idleMs, idleTimeoutMs, settleMs });
    }

    this.finalUrl = this.finalUrl ?? url;
    this.title = await this.evaluate("document.title").catch(() => null);
    return { loadFired, readyState: this.readyState, finalUrl: this.finalUrl, title: this.title };
  }

  async waitUntilReady({ timeoutMs = 20_000, idleMs = 500, idleTimeoutMs = 15_000, settleMs = 600 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let readyState = "unknown";
    while (Date.now() < deadline) {
      readyState = await this.evaluate("document.readyState").catch(() => "unknown");
      if (readyState === "complete") break;
      await sleep(100);
    }
    this.readyState = readyState;
    if (readyState !== "complete") {
      throw new CdpError(`等待 document.readyState === "complete" 超时(${timeoutMs}ms)，当前为 ${readyState}`);
    }

    this.networkIdle = await this.waitForNetworkIdle({
      idleMs,
      timeoutMs: Math.min(idleTimeoutMs, Math.max(1000, deadline - Date.now())),
    });

    await this.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true", { timeoutMs: 5000 }).catch(
      () => {},
    );

    if (settleMs > 0) await sleep(settleMs);
    return this;
  }

  /** 等待网络空闲（连续 idleMs 内没有在途请求）。返回是否真的空闲。 */
  async waitForNetworkIdle({ idleMs = 500, timeoutMs = 15_000 } = {}) {
    const startedAt = Date.now();
    while (true) {
      if (this.#inflight.size === 0) {
        await sleep(idleMs);
        if (this.#inflight.size === 0) return true;
      }
      if (Date.now() - startedAt > timeoutMs) return false;
      await sleep(100);
    }
  }

  async evaluate(expression, { timeoutMs = DEFAULT_TIMEOUT_MS, awaitPromise = true, returnByValue = true } = {}) {
    let result;
    try {
      result = await this.#send(
        "Runtime.evaluate",
        { expression, awaitPromise, returnByValue, allowUnsafeEvalBlockedByCSP: true },
        timeoutMs,
      );
    } catch (error) {
      throw new CdpError(`Runtime.evaluate 失败：${error.message}\n表达式前 200 字符：${String(expression).slice(0, 200)}`);
    }
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const description = details.exception?.description ?? details.text ?? "unknown";
      throw new CdpError(`页面脚本抛异常：${description}`);
    }
    return result.result?.value;
  }

  /** 富信息版 evaluate：拿回 { value, exceptionDetails } 而不抛错。 */
  async evaluateSafe(expression, { timeoutMs = 20_000 } = {}) {
    const result = await this.#send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true },
      timeoutMs,
    );
    return {
      value: result.result?.value,
      exceptionText: result.exceptionDetails
        ? (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown")
        : null,
    };
  }

  /** 截图。fullPage=true 时用 layoutMetrics 做整页裁剪。返回 PNG Buffer。 */
  async screenshot({ fullPage = false, format = "png", timeoutMs = 60_000 } = {}) {
    const params = { format, fromSurface: true };
    let clip = null;
    if (fullPage) {
      await this.evaluate("window.scrollTo(0, 0)").catch(() => {});
      const metrics = await this.#send("Page.getLayoutMetrics", {}, timeoutMs);
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size && size.width > 0 && size.height > 0) {
        const width = Math.max(1, Math.ceil(size.width));
        const height = Math.min(20_000, Math.max(1, Math.ceil(size.height)));
        clip = { x: 0, y: 0, width, height, scale: 1 };
        params.clip = clip;
        params.captureBeyondViewport = true;
      }
    }
    const { data } = await this.#send("Page.captureScreenshot", params, timeoutMs);
    if (!data) throw new CdpError("Page.captureScreenshot 未返回图片数据");
    const buffer = Buffer.from(data, "base64");
    if (buffer.length === 0) throw new CdpError("Page.captureScreenshot 返回空图片");
    this.lastScreenshot = { bytes: buffer.length, fullPage, clip, viewport: { width: this.width, height: this.height } };
    return buffer;
  }

  /** 非阻断失败：canceled 的请求、favicon 等。 */
  get blockingRequestFailures() {
    return this.requestFailures.filter((failure) => !failure.canceled && !FAVICON_RE.test(failure.url));
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#offs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.#offs = [];
    try {
      await this.connection.send("Target.closeTarget", { targetId: this.targetId }, { timeoutMs: 5000 });
    } catch {
      /* ignore */
    }
    try {
      await this.connection.send("Target.detachFromTarget", { sessionId: this.sessionId }, { timeoutMs: 3000 });
    } catch {
      /* ignore */
    }
    this.browser?.pages?.delete(this);
  }
}

export { FAVICON_RE };

/* ------------------------------------------------------------------ *
 * 直接运行 cdp.mjs 时的自检入口：node tools/cdp.mjs --doctor
 * 逐步探测「本机 Chrome 路径 → 启动 → CDP 端口 → 打开页面 → 截图」，把失败原因原文打出来。
 * ------------------------------------------------------------------ */

const isDirectRun = (() => {
  try {
    return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const wantsDoctor = process.argv.includes("--doctor") || process.argv.length <= 2;
  if (!wantsDoctor) {
    console.log("cdp.mjs 是库文件。自检请运行：node tools/cdp.mjs --doctor");
    process.exit(0);
  }
  await runDoctor();

  async function runDoctor() {
    const line = (s = "") => console.log(s);
    line(`# cdp.mjs --doctor`);
    line(`  node ${process.version}（全局 WebSocket: ${typeof WebSocket === "function" ? "可用" : "不可用"}）`);
    const candidates = chromeCandidates().filter(Boolean);
    line(`  Chrome 候选路径：`);
    for (const c of candidates) line(`    ${existsSync(c) ? "[存在]" : "[缺失]"} ${c}`);
    let resolved = null;
    try {
      resolved = resolveChromePath();
      line(`  解析结果：${resolved}`);
    } catch (error) {
      line(`  ✗ 找不到 Chrome：${error.message}`);
      process.exit(2);
    }
    line(`  尝试启动 headless Chrome 并连 CDP …`);
    let browser = null;
    try {
      browser = await Browser.launch({ startupTimeoutMs: 20_000 });
      line(`  ✓ Chrome 已启动：${browser.version?.Browser || "(版本未知)"}`);
      line(`    调试端口：${browser.port}  WebSocket：${browser.browserWsUrl}`);
      const page = await browser.newPage({ width: 800, height: 600 });
      await page.goto("data:text/html,<h1 id=t>doctor-ok</h1>", { timeoutMs: 15_000 });
      const title = await page.evaluate("document.getElementById('t').textContent");
      const png = await page.screenshot({});
      line(`  ✓ 页面求值：${JSON.stringify(title)}  截图字节数：${png.length}`);
      await page.close();
      line(`  ✓ 结论：本终端可以运行 Chrome CDP，工具可用。`);
      await browser.close();
      browser = null;
      process.exit(0);
    } catch (error) {
      line(`  ✗ 失败：${error && error.message ? error.message : error}`);
      if (error && error.details && error.details.chromeLogPath) {
        line(`  Chrome 日志：${error.details.chromeLogPath}`);
      }
      line(`  结论：本终端无法启动 Chromium —— 请在未受限的普通 PowerShell 里重跑。`);
      try {
        if (browser) await browser.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    }
  }
}
