import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({server:{middlewareMode:true}, appType:'custom'});
const storage = new Map();
globalThis.sessionStorage = {
  getItem:key=>storage.get(key) ?? null,
  setItem:(key,value)=>storage.set(key,value),
  removeItem:key=>storage.delete(key),
};
try {
  const {prepareRunSubmission, clearRunSubmission} = await server.ssrLoadModule('/src/utils/runSubmission.ts');
  let revision = 1;
  let requests = 0;
  const api = { getCompany:async () => { requests++; return {revision}; } };
  const draft = {type:'opportunity_discovery', project_id:'p', company_id:'c', document_ids:[]};
  const first = await prepareRunSubmission(api, 'test', draft);
  revision = 2;
  const retry = await prepareRunSubmission(api, 'test', draft);
  assert.deepEqual(retry, first);
  assert.equal(requests, 1);
  assert.equal(first.body.company_revision, 1);
  assert.equal(draft.company_revision, undefined);
  const changed = await prepareRunSubmission(api, 'test', {...draft, options:{max_candidates:2}});
  assert.equal(changed.body.company_revision, 2);
  assert.notEqual(changed.key, first.key);
  clearRunSubmission('test');
  const next = await prepareRunSubmission(api, 'test', draft);
  assert.notEqual(next.key, changed.key);
  assert.equal(next.body.company_revision, 2);
  clearRunSubmission('test');
  sessionStorage.setItem = () => { throw new Error('disabled'); };
  const memory = await prepareRunSubmission(api, 'memory', draft);
  revision = 3;
  assert.deepEqual(await prepareRunSubmission(api, 'memory', draft), memory);
  clearRunSubmission('memory');
  console.log('PASS submission snapshot: exact retry, changed draft, clear, storage unavailable');
} finally { delete globalThis.sessionStorage; await server.close(); }
