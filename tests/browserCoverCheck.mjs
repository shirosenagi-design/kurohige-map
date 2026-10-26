const cdpPort = process.env.CDP_PORT ?? '9225';
const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === 'page');
if (!target) throw new Error('No Chrome page target is available.');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let commandId = 0;
const pending = new Map();
const errors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push({ type: 'exception', text: message.params.exceptionDetails.text });
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push({
    type: 'log', text: message.params.entry.text, url: message.params.entry.url ?? '', source: message.params.entry.source ?? '',
  });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++commandId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
await command('Runtime.enable');
await command('Page.enable');
await command('Log.enable');

const evaluate = async (expression) => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const waitFor = async (predicate, timeout = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${predicate}`);
};
const navigate = async (url) => {
  await command('Page.navigate', { url });
  await waitFor(`document.readyState === 'complete'`);
  await waitFor(`document.querySelector('.product-shell')?.dataset.coverWorldStatus !== 'hydrating'`);
  await new Promise((resolve) => setTimeout(resolve, 300));
};
const reload = async () => {
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`document.readyState === 'complete'`);
  await waitFor(`document.querySelector('.product-shell')?.dataset.coverWorldStatus !== 'hydrating'`);
  await new Promise((resolve) => setTimeout(resolve, 300));
};
const click = async (selector) => {
  const clicked = await evaluate(`(() => { const item = document.querySelector(${JSON.stringify(selector)}); item?.click(); return Boolean(item); })()`);
  if (!clicked) throw new Error(`Could not click ${selector}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
};
const clickButtonText = async (text) => {
  const clicked = await evaluate(`(() => { const item = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(${JSON.stringify(text)})); item?.click(); return Boolean(item); })()`);
  if (!clicked) throw new Error(`Could not click button containing ${text}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
};
const snapshot = () => evaluate(`(async () => {
  const shell = document.querySelector('.product-shell');
  const living = document.querySelector('.living-flow-shell');
  const open = indexedDB.open('kurohige-map-world', 1);
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  const tx = db.transaction('worlds', 'readonly');
  const request = tx.objectStore('worlds').get('active-world');
  const stored = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  db.close();
  const product = JSON.parse(localStorage.getItem('kurohige-map.product-state.v2') || 'null');
  return {
    href: location.href,
    coverVisible: shell?.dataset.coverVisible,
    coverWorldStatus: shell?.dataset.coverWorldStatus,
    coverWorldExists: shell?.dataset.coverWorldExists,
    coverTitle: document.querySelector('.cover-entry h1')?.textContent ?? '',
    coverCta: document.querySelector('.cover-entry button')?.textContent ?? '',
    coverCtaDisabled: document.querySelector('.cover-entry button')?.disabled ?? null,
    coverInputCount: document.querySelectorAll('.cover-screen input, .cover-screen textarea, .cover-screen form').length,
    headerCount: document.querySelectorAll('.product-header').length,
    navCount: document.querySelectorAll('.product-header nav').length,
    profileControlCount: document.querySelectorAll('.product-avatar').length,
    section: shell?.dataset.productSection,
    summaryVisible: Boolean(document.querySelector('.summary-screen')),
    worldCount: Number(living?.dataset.worldCount || 0),
    selectedId: living?.dataset.selectedId ?? '',
    canvasCount: document.querySelectorAll('canvas.map-canvas').length,
    worldId: stored?.snapshot?.worldId ?? null,
    nodeIds: stored?.snapshot?.nodes?.map((node) => node.id) ?? [],
    productNickname: product?.userProfile?.nickname ?? null,
    personCompleted: product?.personState?.completedSteps?.length ?? 0,
    apiCalls: window.__kurohigePersistenceProbe?.calls ?? [],
  };
})()`);

await navigate(`${appUrl}/?persistenceHarness=firstRun`);
const firstRunCover = await snapshot();
await click('.cover-entry button');
const firstRunDestination = await snapshot();

await navigate(`${appUrl}/?persistenceHarness=seed`);
const returningCover = await snapshot();
if (process.env.COVER_SCREENSHOT) {
  const capture = await command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(process.env.COVER_SCREENSHOT, Buffer.from(capture.data, 'base64'));
}
await click('.cover-entry button');
await waitFor(`document.querySelector('.product-shell')?.dataset.productSection === 'map'`);
const returningMap = await snapshot();
await clickButtonText('リスト');
const returningList = await snapshot();
await clickButtonText('マップ');
const beforeReload = await snapshot();

await reload();
const reloadCover = await snapshot();
await click('.cover-entry button');
await waitFor(`document.querySelector('.product-shell')?.dataset.productSection === 'map'`);
const reloadMap = await snapshot();

await navigate(`${appUrl}/?persistenceHarness=corrupt`);
const corruptCover = await snapshot();
await click('.cover-entry button');
const corruptDestination = await snapshot();

console.log(JSON.stringify({
  firstRunCover,
  firstRunDestination,
  returningCover,
  returningMap,
  returningList,
  beforeReload,
  reloadCover,
  reloadMap,
  corruptCover,
  corruptDestination,
  errors,
}, null, 2));
socket.close();
import { writeFileSync } from 'node:fs';
