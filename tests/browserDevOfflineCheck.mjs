const cdpPort = process.env.CDP_PORT ?? '9231';
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
const fatalErrors = [];
const nonFatalResourceErrors = [];
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
  if (message.method === 'Runtime.exceptionThrown') fatalErrors.push({ type: 'exception', text: message.params.exceptionDetails.text });
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    const entry = { type: 'log', text: message.params.entry.text, url: message.params.entry.url ?? '', source: message.params.entry.source ?? '' };
    if (entry.source === 'network' && entry.url.endsWith('/favicon.ico')) nonFatalResourceErrors.push(entry);
    else fatalErrors.push(entry);
  }
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
const waitFor = async (predicate, timeout = 20000) => {
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
  await new Promise((resolve) => setTimeout(resolve, 400));
};
const clickButtonText = async (text) => {
  const clicked = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(${JSON.stringify(text)})); button?.click(); return Boolean(button); })()`);
  if (!clicked) throw new Error(`Could not click button containing ${text}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
};
const readDatabase = (name) => evaluate(`(async () => {
  const request = indexedDB.open(${JSON.stringify(name)}, 1);
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const tx = db.transaction('worlds', 'readonly');
  const storedRequest = tx.objectStore('worlds').get('active-world');
  const stored = await new Promise((resolve, reject) => { storedRequest.onsuccess = () => resolve(storedRequest.result); storedRequest.onerror = () => reject(storedRequest.error); });
  db.close();
  return JSON.stringify(stored?.snapshot ?? null);
})()`);
const normalFingerprint = async () => ({
  product: await evaluate(`localStorage.getItem('kurohige-map.product-state.v2')`),
  world: await readDatabase('kurohige-map-world'),
});
const devSnapshot = async () => ({
  badge: await evaluate(`document.querySelector('.dev-offline-badge')?.innerText ?? ''`),
  worldCount: await evaluate(`Number(document.querySelector('.living-flow-shell')?.dataset.worldCount ?? 0)`),
  hydration: await evaluate(`document.querySelector('.living-flow-shell')?.dataset.worldHydration ?? ''`),
  canvasCount: await evaluate(`document.querySelectorAll('canvas.map-canvas').length`),
  apiBlockedCount: await evaluate(`window.__kurohigeDevOffline?.blockedCount ?? -1`),
  selectedState: await evaluate(`JSON.parse(document.querySelector('.living-flow-shell')?.dataset.selectedNodeState || 'null')`),
  devProduct: await evaluate(`localStorage.getItem('kurohige-map.dev-offline.product-state.v1')`),
  devWorld: await readDatabase('kurohige-map-world-dev-offline'),
});

await navigate(`${appUrl}/?persistenceHarness=seed`);
await waitFor(`document.querySelector('.product-shell')?.dataset.coverWorldStatus === 'ready'`);
const normalBefore = await normalFingerprint();

await navigate(`${appUrl}/?devOffline=1`);
await waitFor(`Boolean(document.querySelector('.dev-offline-root'))`);
const copyButtonPresent = await evaluate(`[...document.querySelectorAll('button')].some((item) => item.textContent?.includes('通常Productの保存データをDEV領域へ複製'))`);
if (copyButtonPresent) await clickButtonText('通常Productの保存データをDEV領域へ複製');
await waitFor(`document.querySelector('.product-shell')?.dataset.coverWorldStatus === 'ready'`);
await clickButtonText('地図をひらく');
await waitFor(`document.querySelector('.living-flow-shell')?.dataset.worldHydration === 'ready' && document.querySelectorAll('canvas.map-canvas').length === 1`);
const beforeInteraction = await devSnapshot();

const box = await evaluate(`(() => { const r = document.querySelector('canvas.map-canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const x = box.x + box.width * .55;
const y = box.y + box.height * .55;
await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -180 });
await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y + 160, button: 'left', buttons: 1 });
await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y + 160, button: 'left', clickCount: 1 });
await new Promise((resolve) => setTimeout(resolve, 700));
const afterCamera = await devSnapshot();

await clickButtonText('この島へ進む');
const offlineUnavailable = {
  notice: await evaluate(`document.querySelector('.living-selected-card .living-flow-error')?.textContent ?? ''`),
  apiBlockedCount: await evaluate(`window.__kurohigeDevOffline?.blockedCount ?? -1`),
  selectedState: await evaluate(`JSON.parse(document.querySelector('.living-flow-shell')?.dataset.selectedNodeState || 'null')`),
};
await clickButtonText(beforeInteraction.selectedState?.kept ? 'キープ中' : 'キープ');
await new Promise((resolve) => setTimeout(resolve, 500));
const afterDevMutation = await devSnapshot();
const normalAfterMutation = await normalFingerprint();

await command('Page.reload', { ignoreCache: true });
await waitFor(`document.readyState === 'complete'`);
await waitFor(`document.querySelector('.product-shell')?.dataset.coverWorldStatus === 'ready'`);
await clickButtonText('地図をひらく');
await waitFor(`document.querySelector('.living-flow-shell')?.dataset.worldHydration === 'ready'`);
const afterReload = await devSnapshot();
const normalAfterReload = await normalFingerprint();

await navigate(`${appUrl}/`);
await waitFor(`document.querySelector('.product-shell')?.dataset.coverWorldStatus === 'ready'`);
const normalRoute = {
  devRootPresent: await evaluate(`Boolean(document.querySelector('.dev-offline-root'))`),
  worldCount: await evaluate(`Number(document.querySelector('.living-flow-shell')?.dataset.worldCount ?? 0)`),
  worldId: JSON.parse(await readDatabase('kurohige-map-world'))?.worldId,
};

const result = {
  beforeInteraction: { worldCount: beforeInteraction.worldCount, hydration: beforeInteraction.hydration, canvasCount: beforeInteraction.canvasCount, apiBlockedCount: beforeInteraction.apiBlockedCount, badge: beforeInteraction.badge },
  cameraInteraction: { worldCountBefore: beforeInteraction.worldCount, worldCountAfter: afterCamera.worldCount, canvasCount: afterCamera.canvasCount, apiBlockedCount: afterCamera.apiBlockedCount },
  offlineUnavailable: { notice: offlineUnavailable.notice, apiBlockedCount: offlineUnavailable.apiBlockedCount },
  devIsolation: {
    copyButtonPresent,
    keptBefore: beforeInteraction.selectedState?.kept,
    keptAfter: afterDevMutation.selectedState?.kept,
    keptAfterReload: afterReload.selectedState?.kept,
    devWorldId: JSON.parse(afterReload.devWorld)?.worldId,
    normalUnchangedAfterMutation: normalBefore.product === normalAfterMutation.product && normalBefore.world === normalAfterMutation.world,
    normalUnchangedAfterReload: normalBefore.product === normalAfterReload.product && normalBefore.world === normalAfterReload.world,
  },
  apiBlockedCount: afterReload.apiBlockedCount,
  normalRoute,
  fatalErrors,
  nonFatalResourceErrors,
};

if (beforeInteraction.worldCount !== 18 || beforeInteraction.canvasCount !== 1) throw new Error('Copied DEV World did not render as expected.');
if (afterCamera.worldCount !== 18 || afterCamera.canvasCount !== 1 || afterCamera.apiBlockedCount !== 0) throw new Error('Camera interaction changed World or attempted API access.');
if (!offlineUnavailable.notice.includes('DEV節約モード') || offlineUnavailable.apiBlockedCount !== 0
  || JSON.stringify(offlineUnavailable.selectedState) !== JSON.stringify(beforeInteraction.selectedState)) throw new Error('Unavailable AI action was not reported safely.');
if (afterDevMutation.selectedState?.kept === beforeInteraction.selectedState?.kept || afterReload.selectedState?.kept !== afterDevMutation.selectedState?.kept) throw new Error('DEV-only mutation did not persist independently.');
if (!result.devIsolation.normalUnchangedAfterMutation || !result.devIsolation.normalUnchangedAfterReload) throw new Error('Normal Product storage changed during DEV use.');
if (normalRoute.devRootPresent || normalRoute.worldCount !== 18 || normalRoute.worldId === result.devIsolation.devWorldId) throw new Error('Normal Product route mixed DEV data.');
if (fatalErrors.length) throw new Error(`Browser fatal errors: ${JSON.stringify(fatalErrors)}`);

console.log(JSON.stringify(result, null, 2));
socket.close();
