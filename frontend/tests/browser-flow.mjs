// Offline browser regression: serves the production build and synthetic HTTP APIs.
// Node 24 + installed Chrome/Edge; never connects to the business API or database.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '.verification', 'project-flow');
await mkdir(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const projects = [{ project_id: 'p_old', name: '历史评审项目' }, { project_id: 'p_empty', name: '尚未运行的项目' }];
let status = 'awaiting_review', stale = false, failCreate = false, failList = false, createdCount = 0;
let history = false;
let entryDelay = 0;
const run = () => ({ run_id: 'r_latest', project_id: 'p_old', type: 'bid_evaluation', status, created_at: '2026-10-15T00:00:00Z', updated_at: '2026-10-15T00:00:00Z', current_step: 'extract', known_steps: ['ingest', 'extract', 'assess', 'report'], completed_steps: ['ingest'], revision: 2, review_count: status === 'awaiting_review' ? 1 : 0, result_stale: stale });
const paged = (items, next_cursor = null) => ({ items, next_cursor });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const error = (code, message) => send({ error: { code: 'test_error', message, request_id: 'test' } }, code);
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.includes('/health/')) return send({ status: 'ready' });
    if (url.pathname === '/api/v1/projects') {
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        await sleep(200);
        if (failCreate) return error(500, '模拟创建失败');
        createdCount++;
        const project = { project_id: 'p_new', name: JSON.parse(body).name };
        projects.push(project); return send(project, 201);
      }
      if (url.searchParams.get('limit') === '20' && projects.length > 2) {
        return send(url.searchParams.get('cursor') ? paged(projects.slice(2)) : paged(projects.slice(0, 2), 'projects-next'));
      }
      return send(paged(projects));
    }
    if (url.pathname === '/api/v1/runs') {
      if (url.searchParams.get('project_id') === 'p_old') await sleep(entryDelay);
      if (failList) return error(503, '模拟进度查询失败');
      if (url.searchParams.has('project_id') && url.searchParams.get('project_id') !== 'p_old') return send(paged([]));
      return send(url.searchParams.get('cursor') ? paged([run()]) : paged([{ ...run(), run_id: 'r_zold', created_at: '2026-10-01T00:00:00Z', status: 'failed' }], 'next'));
    }
    if (/\/runs\/[^/]+$/.test(url.pathname)) return send(run());
    if (url.pathname.endsWith('/reviews')) return send(paged(history ? [{ kind: 'history', review_id: '1', target_id: 'extract', revision: 1, payload: { decision: 'confirm', reason: '确认', at: '2026-10-15T00:00:00Z' } }] : []));
    if (url.pathname.endsWith('/events')) return send(paged([]));
    if (url.pathname.endsWith('/results')) return error(409, '结果尚未就绪');
    if (url.pathname.endsWith('/reports')) return send(paged(status === 'succeeded' ? [{ report_id: '1', run_id: 'r_latest', revision: 2, confirmed: !stale, stale, data: {} }] : []));
    if (url.pathname === '/api/v1/reports/1') return send({ report_id: '1', run_id: 'r_latest', revision: 2, confirmed: !stale, stale, data: {} });
    return error(404, '没有测试数据');
  }
  try {
    const file = resolve(root, 'dist', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(resolve(root, 'dist') + sep)) return error(403, 'invalid path');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] ?? 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'review-flow-test-'));
const chromePath = process.env.CHROME_PATH ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chromePath) throw new Error('Set CHROME_PATH to an installed Chrome/Edge executable');
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
const checks = [], errors = [];
const pending = new Map(); let seq = 0;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS', name); };
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await sleep(100); } }
  if (!port) throw new Error('Chrome did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.id) { const p = pending.get(data.id); pending.delete(data.id); if (p) { clearTimeout(p.timer); data.error ? p.reject(new Error(data.error.message)) : p.resolve(data.result); } }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText')}`);
  };
  let navigation = 0;
  const goto = async hash => { await send('Page.navigate', { url: `${base}/?test=${++navigation}#${hash}` }); await until('!!document.querySelector(".view")'); };
  const click = async text => { await until(`Array.from(document.querySelectorAll('button')).some(e=>e.textContent.includes(${JSON.stringify(text)})&&!e.disabled)`); await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes(${JSON.stringify(text)})&&!e.disabled).click()`); };
  const fill = async value => evaluate(`(()=>{const el=document.querySelector('input[placeholder="输入项目名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await goto('/projects'); await until('document.querySelectorAll(".project-card").length===2');
  check('independent copy buttons, no nested interactive controls', await evaluate('!document.querySelector("a button")'));
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }).then(r => writeFile(join(out, 'projects-desktop.png'), Buffer.from(r.data, 'base64')));
  failCreate = true; await fill('失败时保留名称'); await click('创建项目'); await until('document.body.innerText.includes("模拟创建失败")');
  check('failed create retains route and input', await evaluate('location.hash==="#/projects" && document.querySelector("input").value==="失败时保留名称"'));
  failCreate = false; await fill('新建线性流程验收');
  await evaluate('document.querySelector("form").requestSubmit();document.querySelector("form").requestSubmit()');
  await until('location.hash==="#/projects/p_new/upload" && !!document.querySelector(".breadcrumbs")');
  check('create navigates exactly once with toast', createdCount === 1 && await evaluate('document.body.innerText.includes("项目已创建，请上传材料")'));
  check('step one complete, upload current, future steps locked', await evaluate('document.querySelectorAll(".phase")[0].innerText.includes("✓") && document.querySelectorAll(".phase")[1].getAttribute("aria-current")==="step" && document.querySelectorAll(".phase [aria-disabled=true]").length===3'));
  check('breadcrumb project name survives navigation', await evaluate('document.querySelector(".breadcrumbs").innerText.includes("新建线性流程验收")'));
  await send('Page.captureScreenshot', { format: 'png' }).then(r => writeFile(join(out, 'upload-desktop.png'), Buffer.from(r.data, 'base64')));
  await goto('/projects'); await until('document.querySelectorAll(".project-card").length===2'); await click('下一页');
  await until('document.querySelector(".project-card").innerText.includes("新建线性流程验收")');
  check('project cursor pagination still works', true);
  await click('上一页'); await until('document.querySelector(".project-card").innerText.includes("历史评审项目")');
  await evaluate('document.querySelector(".project-card button").click()');
  check('copy ID does not navigate', await evaluate('location.hash==="#/projects"'));
  await click('刷新');
  entryDelay = 300; await click('进入项目');
  await evaluate('document.querySelectorAll(".project-card__name")[1].click()');
  await until('location.hash==="#/projects/p_empty"');
  await sleep(800);
  check('late project entry cannot override subsequent navigation', await evaluate('location.hash==="#/projects/p_empty"'));
  entryDelay = 0;
  await goto('/runs/new?project_id=p_old'); await until('!!document.querySelector(".breadcrumbs")');
  check('project-scoped run keeps form and breadcrumbs on same project', await evaluate('document.querySelector("input[placeholder=project_id]").readOnly'));
  await goto('/runs/new');
  check('standalone run creation retains manual project ID entry', await evaluate('!document.querySelector("input[placeholder=project_id]").readOnly'));
  await goto('/runs/new?project_id=p_old'); await until('!!document.querySelector(".breadcrumbs")');
  check('new run does not inherit old run report or review navigation', await evaluate('!document.querySelectorAll(".phase")[3].querySelector("a") && !document.querySelectorAll(".phase")[4].querySelector("a")'));
  await goto('/projects'); await until('!!document.querySelector(".project-card button")'); await click('进入项目'); await until('location.hash==="#/runs/r_latest/review" && !!document.querySelector(".breadcrumbs")');
  check('old project picks newest run across pages and opens review', true);
  check('pending review cannot navigate to locked report and lose drafts', await evaluate('!document.querySelector(".view--review a[href*=report]")'));
  await evaluate('document.querySelectorAll(".phase a")[1].click()'); await until('location.hash.includes("/projects/p_old/upload")');
  check('back navigation preserves run context', await evaluate('location.hash.includes("run_id=r_latest")'));
  await until('document.querySelectorAll(".phase")[3].querySelector("a")!==null');
  check('back navigation keeps later review reachable', true);
  status = 'pending'; history = true; await goto('/runs/r_latest'); await until('document.body.innerText.includes("复核已提交，继续运行")');
  check('review continuation displays resumed processing', true);
  status = 'succeeded'; await goto('/runs/r_latest/report'); await until('!!document.querySelector(".view--report") && document.querySelectorAll(".phase")[4].querySelector("a")!==null');
  check('valid report unlocks final step', true);
  stale = true; await goto('/runs/r_latest/report'); await until('location.hash==="#/runs/r_latest" && document.body.innerText.includes("报告尚未就绪或已过期")');
  check('stale report deep link redirects to progress', true);
  status = 'running'; history = false; stale = false; await goto('/runs/r_latest/review'); await until('location.hash==="#/runs/r_latest"');
  check('future review deep link is guarded', true);
  await goto('/projects'); await until('!!document.querySelector(".project-card button")'); failList = true; await click('进入项目'); await until('document.body.innerText.includes("模拟进度查询失败")');
  check('failed entry stays on project list with retry', await evaluate('location.hash==="#/projects"'));
  failList = false;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await goto('/projects/p_new/upload'); await until('!!document.querySelector(".breadcrumbs")');
  check('mobile page has no horizontal document overflow', await evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
  check('mobile steps can scroll', await evaluate('document.querySelector(".phaserail").scrollWidth > document.querySelector(".phaserail").clientWidth'));
  await send('Page.captureScreenshot', { format: 'png' }).then(r => writeFile(join(out, 'upload-mobile.png'), Buffer.from(r.data, 'base64')));
  await goto('/projects?demo=1'); await until('document.body.innerText.includes("离线演示模式下不可写入")');
  check('demo create remains disabled', await evaluate('Array.from(document.querySelectorAll("button")).find(e=>e.textContent.includes("创建项目")).disabled'));
  check('no browser runtime exceptions', errors.length === 0);
  await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
  console.log(`${checks.length} browser checks passed. Screenshots: ${out}`);
} catch (error) {
  await writeFile(join(out, 'result.json'), JSON.stringify({ passed: false, checks, errors, failure: String(error) }, null, 2));
  throw error;
} finally {
  socket?.close();
  for (const value of pending.values()) clearTimeout(value.timer);
  chrome.kill(); server.closeAllConnections(); await new Promise(r => server.close(r));
  await sleep(500);
  const resolvedProfile = resolve(profile);
  if (resolvedProfile.startsWith(resolve(tmpdir()) + sep) && resolvedProfile.split(sep).at(-1).startsWith('review-flow-test-')) {
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
