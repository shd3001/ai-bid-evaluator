import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({server:{middlewareMode:true}, appType:'custom'});
const originalFetch = globalThis.fetch;
try {
  const { probeMode } = await server.ssrLoadModule('/src/api/mode.ts');
  globalThis.window = {location:{hash:'#/projects', search:''}};
  globalThis.fetch = async () => new Response('<!doctype html><html>SPA fallback</html>', {headers:{'Content-Type':'text/html'}});
  assert.equal((await probeMode()).mode, 'demo', 'HTTP 200 HTML must not masquerade as a ready API');
  globalThis.fetch = async () => Response.json({status:'not_ready'});
  assert.equal((await probeMode()).mode, 'demo');
  globalThis.fetch = async () => Response.json({status:'ready', model_configured:false});
  assert.equal((await probeMode()).mode, 'live');
  window.location.hash = '#/projects?demo=0';
  globalThis.fetch = async () => new Response('<html>fallback</html>');
  const forced = await probeMode();
  assert.equal(forced.mode, 'live');
  assert.equal(forced.health.ok, false);
  console.log('PASS mode regression: HTML fallback, malformed health, ready, forced live');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.window;
  await server.close();
}
