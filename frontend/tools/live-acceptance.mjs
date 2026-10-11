// Real browser + real HTTP. Requires scripts/serve_acceptance.py (synthetic services).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Browser, sleep } from './cdp.mjs';

const base = process.env.ACCEPTANCE_URL || 'http://127.0.0.1:8765';
const out = new URL('../../.verification/phase5/live/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await Browser.launch();
let page;
const pageErrors = [];
const stopErrors = browser.connection.on('Runtime.exceptionThrown', (params) => {
  pageErrors.push(params.exceptionDetails);
});
let passed = false;
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
async function until(expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await page.evaluate(expression);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${expression}\n${await page.evaluate('document.body.innerText')}`);
}
async function goto(path) {
  await page.goto(`${base}/#${path}`, { waitForLoad: false, idleTimeoutMs: 1000, settleMs: 150 });
}
async function fill(selector, value) {
  await until(`!!document.querySelector(${JSON.stringify(selector)})`);
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}
async function click(text) {
  await until(`Array.from(document.querySelectorAll('button')).some(e => e.textContent.includes(${JSON.stringify(text)}) && !e.disabled)`);
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(e => e.textContent.includes(${JSON.stringify(text)}) && !e.disabled).click()`);
}
async function api(path, method = 'GET', body, key) {
  return page.evaluate(`(async () => {
    const r = await fetch('/api/v1' + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)}, headers: {'Content-Type':'application/json', 'Idempotency-Key':${JSON.stringify(key || crypto.randomUUID())}},
      ${body === undefined ? '' : `body:JSON.stringify(${JSON.stringify(body)}),`}
    });
    return {status:r.status, data:await r.json()};
  })()`);
}
async function upload(pid, role, text, bidder) {
  return page.evaluate(`(async () => {
    const f = new FormData(); f.append('project_id', ${JSON.stringify(pid)}); f.append('role', ${JSON.stringify(role)});
    f.append('file', new File([${JSON.stringify(text)}], '${role}.txt', {type:'text/plain'}));
    ${bidder ? `f.append('bidder_id', ${JSON.stringify(bidder)});` : ''}
    const r = await fetch('/api/v1/documents', {method:'POST', body:f});
    if (!r.ok) throw new Error(await r.text()); return r.json();
  })()`);
}
async function runState(id, status) {
  return until(`fetch('/api/v1/runs/${id}').then(r=>r.json()).then(r=>r.status === '${status}' && r)`);
}
async function confirm(id) {
  await runState(id, 'awaiting_review');
  await goto(`/runs/${id}/review`);
  await fill('textarea[required]', '验收：逐条核对合成材料原文与证据');
  await click('提交');
  return runState(id, 'succeeded');
}
try {
  page = await browser.newPage({ width: 1440, height: 900 });
  await goto('/projects?demo=0');
  await fill('input[placeholder="输入项目名称"]', '第五阶段联调 ' + Date.now());
  await click('创建项目');
  await until(`document.body.innerText.includes('项目已创建')`);
  const pid = (await api('/projects')).data.items[0].project_id;
  check('UI creates project via live API', !!pid);

  await goto(`/projects/${pid}/upload`);
  await page.evaluate(`document.querySelector('input[value="announcement"]').click()`);
  await page.evaluate(`(() => {
    const input = document.querySelector('input[type=file]'); const dt = new DataTransfer();
    dt.items.add(new File(['公告资格要求'], 'announcement.txt', {type:'text/plain'}));
    input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await click('上传');
  await until(`document.body.innerText.includes('已提交：announcement.txt')`);
  check('UI uploads and stores document receipt', await page.evaluate(`document.body.innerText.includes('看解析')`));
  const docIds = [await page.evaluate(`Array.from(document.querySelectorAll('a')).find(a=>a.textContent.includes('看解析')).hash.split('/')[2]`)];
  docIds.push((await upload(pid, 'tender', '施工资质；技术满分10')).document_id);
  for (const name of ['BidA', 'BidB']) {
    const bidder = (await api(`/projects/${pid}/bidders`, 'POST', {name})).data.bidder_id;
    docIds.push((await upload(pid, 'bid', `${name} 施工资质有效，技术方案`, bidder)).document_id);
  }
  await goto(`/runs/new?project_id=${pid}`);
  await fill('textarea', docIds.join(','));
  await click('提交运行');
  const bidId = await until(`location.hash.startsWith('#/runs/run_') && location.hash.split('/')[2].split('?')[0]`);
  await confirm(bidId);
  check('UI bid run creation and manual review complete', true);
  const results = (await api(`/runs/${bidId}/results`)).data;
  check('Exact backend score strings survive HTTP', results.data.scores.map(s=>s.total_score).sort().join(',') === '6.25,8.5');
  const ref = results.evidence_matrix[0];
  check('Evidence resolves to original chunk', (await api(`/documents/${ref.document_id}/chunks?limit=100`)).data.items.some(c=>c.chunk_id === ref.chunk_id && c.text.includes(ref.quote)));
  await goto(`/runs/${bidId}/report`);
  await click('导出 json');
  await until(`document.body.innerText.includes('8.5')`);
  await writeFile(new URL('bid-report.png', out), await page.screenshot());
  const reports = (await api(`/runs/${bidId}/reports`)).data.items;
  for (const format of ['json', 'markdown', 'html']) {
    check(`Report export ${format}`, await page.evaluate(`fetch('/api/v1/reports/${reports[0].report_id}/export?format=${format}').then(r=>r.ok)`));
  }

  const oppPid = (await api('/projects', 'POST', {name:'机会联调'})).data.project_id;
  const profile = await upload(oppPid, 'profile', '企业持有施工资质');
  await goto(`/runs/new?project_id=${oppPid}`);
  await page.evaluate(`document.querySelectorAll('input[type=radio]')[1].click()`);
  await fill('textarea', profile.document_id);
  await click('提交运行');
  const oppId = await until(`location.hash.startsWith('#/runs/run_') && location.hash.split('/')[2].split('?')[0]`);
  await confirm(oppId);
  check('UI opportunity run and profile review complete', true);
  const company = (await api('/companies')).data.items[0];

  // Regression: entered company must actually be sent, with its current revision.
  const reusePid = (await api('/projects', 'POST', {name:'画像复用联调'})).data.project_id;
  await goto(`/runs/new?project_id=${reusePid}`);
  await page.evaluate(`document.querySelectorAll('input[type=radio]')[1].click()`);
  await fill('input[placeholder="company_id"]', company.company_id);
  await page.evaluate(`(() => {
    const realFetch = window.fetch;
    window.retryProbe = { companies:0, posts:[] };
    window.fetch = async (url, options) => {
      if (String(url).includes('/companies/${company.company_id}')) {
        retryProbe.companies++;
        const r = await realFetch(url, options); const data = await r.json();
        if (retryProbe.companies > 1) data.revision++;
        return new Response(JSON.stringify(data), {status:200});
      }
      if (String(url).endsWith('/api/v1/runs') && options?.method === 'POST') {
        retryProbe.posts.push({body:options.body, key:new Headers(options.headers).get('Idempotency-Key')});
        const r = await realFetch(url, options);
        if (retryProbe.posts.length === 1) throw new TypeError('simulated lost response after commit');
        return r;
      }
      return realFetch(url, options);
    };
  })()`);
  await click('提交运行');
  await until(`document.body.innerText.includes('无法连接')`);
  await click('提交运行');
  const reuseId = await until(`location.hash.startsWith('#/runs/run_') && location.hash.split('/')[2].split('?')[0]`, 5000);
  await runState(reuseId, 'succeeded');
  check('UI reuses confirmed company with revision and no new material', true);
  check('Lost response retries exact body and key despite profile version change', await page.evaluate(`retryProbe.companies === 1 && retryProbe.posts.length === 2 && retryProbe.posts[0].body === retryProbe.posts[1].body && retryProbe.posts[0].key === retryProbe.posts[1].key`));

  const body = {type:'opportunity_discovery', project_id:reusePid,
    company_id:company.company_id, company_revision:company.revision};
  const key = crypto.randomUUID();
  const first = await api('/runs', 'POST', body, key);
  const replay = await api('/runs', 'POST', body, key);
  check('Same idempotency key replays same run', first.status === 202 && replay.data.run_id === first.data.run_id);
  const conflict = await api('/runs', 'POST', {...body, options:{max_candidates:2}}, key);
  check('Changed payload with same key is rejected', conflict.status === 409);
  const current = (await api(`/runs/${bidId}`)).data;
  const oldReview = await api(`/runs/${bidId}/reviews`, 'POST', {
    decision:'edit', target_id:'assess', reason:'stale revision test', expected_version:current.revision - 1,
    patch:{scores:results.data.scores, qualifications:results.data.qualifications},
  });
  check('Stale review cannot overwrite current revision', oldReview.status === 409);
  const edited = await api(`/runs/${bidId}/reviews`, 'POST', {
    decision:'edit', target_id:'assess', reason:'report invalidation test', expected_version:current.revision,
    patch:{scores:results.data.scores, qualifications:results.data.qualifications},
  });
  check('Confirmed edit invalidates historical report', edited.status === 201 && (await api(`/reports/${reports[0].report_id}`)).data.stale);
  check('Historical stale report export rejected', await page.evaluate(`fetch('/api/v1/reports/${reports[0].report_id}/export').then(r=>r.status === 409)`));
  await runState(bidId, 'succeeded');
  check('No uncaught browser exception across all pages', pageErrors.length === 0);
  passed = true;
} finally {
  try {
    await writeFile(new URL('result.json', out), JSON.stringify({generated_at:new Date().toISOString(), passed, checks, pageErrors}, null, 2));
  } finally {
    stopErrors();
    await browser.close();
  }
}

