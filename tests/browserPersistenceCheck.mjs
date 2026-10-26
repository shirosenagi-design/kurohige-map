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
const fatalErrors = [];
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
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') fatalErrors.push({
    type: 'log',
    text: message.params.entry.text,
    url: message.params.entry.url ?? '',
    source: message.params.entry.source ?? '',
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
  await waitFor(`document.querySelector('.living-flow-shell')?.dataset.worldHydration !== 'hydrating'`);
  await new Promise((resolve) => setTimeout(resolve, 500));
};

const reload = async () => {
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`document.readyState === 'complete'`);
  await waitFor(`document.querySelector('.living-flow-shell')?.dataset.worldHydration !== 'hydrating'`);
  await new Promise((resolve) => setTimeout(resolve, 500));
};

const snapshot = () => evaluate(`(async () => {
  const shell = document.querySelector('.living-flow-shell');
  const state = shell?.dataset ?? {};
  const open = indexedDB.open('kurohige-map-world', 1);
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  const tx = db.transaction('worlds', 'readonly');
  const request = tx.objectStore('worlds').get('active-world');
  const stored = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  db.close();
  const product = JSON.parse(localStorage.getItem('kurohige-map.product-state.v2') || 'null');
  return {
    href: location.href,
    hydration: state.worldHydration,
    persistenceError: state.worldPersistenceError,
    worldCount: Number(state.worldCount || 0),
    visibleCount: Number(state.visibleCount || 0),
    activePursuit: state.activePursuit,
    landedCount: Number(state.landedCount || 0),
    explorationBand: Number(state.explorationBand || 0),
    selectedId: state.selectedId,
    selectedNodeState: state.selectedNodeState ? JSON.parse(state.selectedNodeState) : null,
    detailCacheCount: Number(state.detailCacheCount || 0),
    personState: state.personState ? JSON.parse(state.personState) : null,
    canvasCount: document.querySelectorAll('canvas.map-canvas').length,
    productNickname: product?.userProfile?.nickname,
    productRevision: product?.personContextRevision,
    worldId: stored?.snapshot?.worldId ?? null,
    worldRevision: stored?.snapshot?.worldRevision ?? null,
    persistedNodeIds: stored?.snapshot?.nodes?.map((node) => node.id) ?? [],
    persistedShip: stored?.snapshot?.ship?.settledPosition ?? null,
    persistedSelected: stored?.snapshot?.selectedNodeId ?? null,
    persistedDetailCount: stored?.snapshot?.detailCache ? Object.keys(stored.snapshot.detailCache).length : 0,
    persistedKeptIds: stored?.snapshot?.nodes?.filter((node) => stored.snapshot.nodeStates[node.id]?.kept).map((node) => node.id) ?? [],
    persistedVisitedIds: stored?.snapshot?.nodes?.filter((node) => stored.snapshot.nodeStates[node.id]?.visited).map((node) => node.id) ?? [],
    persistedActiveIds: stored?.snapshot?.nodes?.filter((node) => stored.snapshot.nodeStates[node.id]?.activePursuit).map((node) => node.id) ?? [],
    persistedLandedIds: stored?.snapshot?.nodes?.filter((node) => stored.snapshot.nodeStates[node.id]?.landed).map((node) => node.id) ?? [],
    persistedStepCounts: stored?.snapshot?.stepCatalog ? Object.fromEntries(Object.entries(stored.snapshot.stepCatalog).map(([id, steps]) => [id, steps.length])) : {},
    persistedCompletedByNode: stored?.snapshot?.nodeStates ? Object.fromEntries(Object.entries(stored.snapshot.nodeStates).filter(([, state]) => state.completedStepIds.length).map(([id, state]) => [id, state.completedStepIds])) : {},
    apiCalls: window.__kurohigePersistenceProbe?.calls ?? [],
  };
})()`);

await navigate(`${appUrl}/?persistenceHarness=seed`);
const seeded = await snapshot();
await reload();
const reloaded = await snapshot();

await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('のぞく'));
  if (!button) return false;
  button.click();
  return true;
})()`);
await new Promise((resolve) => setTimeout(resolve, 250));
const peek = await evaluate(`({
  open: Boolean(document.querySelector('.living-peek-backdrop')),
  text: document.body.innerText.includes('どんなことをする？') && document.body.innerText.includes('今のあなたとどうつながる？'),
  apiCalls: window.__kurohigePersistenceProbe?.calls ?? [],
})`);
await evaluate(`(() => {
  const close = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('閉じる'));
  close?.click();
  const list = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('リスト'));
  list?.click();
  return true;
})()`);
await new Promise((resolve) => setTimeout(resolve, 150));
const listCheck = await evaluate(`({
  section: document.querySelector('.product-shell')?.dataset.productSection,
  hasKept: document.body.innerText.includes('キープ中'),
  hasLanded: document.body.innerText.includes('上陸済み'),
  worldCount: Number(document.querySelector('.living-flow-shell')?.dataset.worldCount || 0),
})`);

await navigate(`${appUrl}/?persistenceHarness=corrupt`);
const corrupt = await snapshot();
await reload();
const afterCorruptReload = await snapshot();

const result = { seeded, reloaded, peek, listCheck, corrupt, afterCorruptReload, fatalErrors };
console.log(JSON.stringify(result, null, 2));
socket.close();
