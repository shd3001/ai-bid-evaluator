import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { Browser, sleep } from './cdp.mjs';
const browser = await Browser.launch();
try {
  const page = await browser.newPage({width:390, height:844, theme:'dark'});
  await page.goto('http://127.0.0.1:8765/#/projects?demo=1', {waitForLoad:false});
  for (let i=0; i<100 && !await page.evaluate(`!!document.querySelector('.brand__name')`); i++) await sleep(100);
  assert.equal(page.pageErrors.length, 0, 'Demo boots without browser exceptions');
  const layout = await page.evaluate(`({
    brand:document.querySelector('.brand__name').getBoundingClientRect().height,
    links:[...document.querySelectorAll('.topnav__link')].map(e=>e.getBoundingClientRect().height),
    pageWidth:document.documentElement.scrollWidth,
    viewport:innerWidth,
  })`);
  await mkdir(new URL('../../.verification/phase5/mobile/', import.meta.url), {recursive:true});
  await writeFile(new URL('../../.verification/phase5/mobile/projects-dark.png', import.meta.url), await page.screenshot());
  assert.ok(layout.brand < 30, `Mobile brand wraps vertically: ${JSON.stringify(layout)}`);
  assert.ok(layout.links.every(h=>h <= 44), 'Navigation labels must remain on one line');
  assert.ok(layout.pageWidth <= layout.viewport, 'No horizontal page overflow');
  console.log('PASS mobile navigation: single-line labels and no page overflow');
} finally { await browser.close(); }
