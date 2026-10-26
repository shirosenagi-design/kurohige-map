import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { completeLocalStep, type LocalSmallStep, type PossibilityNode } from '../src/livingFlow.ts';
import {
  PRODUCT_STATE_STORAGE_KEY,
  createEmptyPersistedProductState,
  createInitialProductState,
  createLocalStorageProductStateRepository,
  parsePersistedProductState,
  persistedSnapshot,
  productStateReducer,
  type BrowserStorage,
  type ObservedPersonSignal,
} from '../src/productState.ts';
import { enMessages, jaMessages, message } from '../src/i18n.ts';

const context = {
  interests: [] as string[],
  engagementPatterns: [] as string[],
  constraints: [] as string[],
  recentChanges: [] as string[],
};

const completeProfile = {
  nickname: 'クロ',
  region: { countryCode: 'JP', administrativeArea: '東京都' },
  updatedAt: '',
};

test('all-empty Summary with missing required Profile remains blocked without inventing context progress', () => {
  const initial = createInitialProductState();
  const next = productStateReducer(initial, { type: 'CONFIRM_PERSON_CONTEXT', context });
  assert.equal(next.onboardingComplete, false);
  assert.equal(next.personContextRevision, 0);
  assert.deepEqual(next.personState, initial.personState);
});

test('nickname only remains blocked', () => {
  let state = createInitialProductState();
  state = productStateReducer(state, { type: 'UPDATE_PROFILE', profile: { nickname: 'クロ', updatedAt: '' }, confirmedAt: '2026-10-04T00:00:00.000Z' });
  state = productStateReducer(state, { type: 'CONFIRM_PERSON_CONTEXT', context });
  assert.equal(state.onboardingComplete, false);
});

test('nickname and country only remain blocked', () => {
  let state = createInitialProductState();
  state = productStateReducer(state, { type: 'UPDATE_PROFILE', profile: { nickname: 'クロ', region: { countryCode: 'JP' }, updatedAt: '' }, confirmedAt: '2026-10-04T00:00:00.000Z' });
  state = productStateReducer(state, { type: 'CONFIRM_PERSON_CONTEXT', context });
  assert.equal(state.onboardingComplete, false);
});

test('nickname, country, and administrative area allow empty-Summary onboarding', () => {
  let state = createInitialProductState();
  state = productStateReducer(state, { type: 'UPDATE_PROFILE', profile: completeProfile, confirmedAt: '2026-10-04T00:00:00.000Z' });
  state = productStateReducer(state, { type: 'CONFIRM_PERSON_CONTEXT', context });
  assert.equal(state.onboardingComplete, true);
});

test('no-op Summary confirm does not increment personContextRevision', () => {
  const initial = productStateReducer(createInitialProductState(), { type: 'UPDATE_PROFILE', profile: completeProfile, confirmedAt: '2026-10-04T00:00:00.000Z' });
  const edited = productStateReducer(initial, {
    type: 'CONFIRM_PERSON_CONTEXT',
    context: { ...context, interests: ['海辺の文化'] },
  });
  const repeated = productStateReducer(edited, {
    type: 'CONFIRM_PERSON_CONTEXT',
    context: { ...context, interests: ['海辺の文化'] },
  });
  assert.equal(edited.personContextRevision, initial.personContextRevision + 1);
  assert.equal(repeated.personContextRevision, edited.personContextRevision);
});

test('generation-relevant Summary edit increments revision exactly once', () => {
  const initial = createInitialProductState();
  const next = productStateReducer(initial, {
    type: 'CONFIRM_PERSON_CONTEXT',
    context: { ...context, constraints: ['夜間の活動は避けたい'] },
  });
  assert.equal(next.personContextRevision, 1);
  assert.deepEqual(next.personState.constraints, ['夜間の活動は避けたい']);
});

test('nickname and avatar-only edits do not increment revision', () => {
  const initial = createInitialProductState();
  const next = productStateReducer(initial, {
    type: 'UPDATE_PROFILE',
    profile: { nickname: 'クロ', avatarRef: 'data:image/png;base64,AA==', updatedAt: '' },
    confirmedAt: '2026-10-04T00:00:00.000Z',
  });
  assert.equal(next.personContextRevision, 0);
  assert.equal(next.userProfile.nickname, 'クロ');
});

test('region changes are generation-relevant while an empty no-op remains valid', () => {
  const initial = createInitialProductState();
  const empty = productStateReducer(initial, {
    type: 'UPDATE_PROFILE', profile: { updatedAt: '' }, confirmedAt: '2026-10-04T00:00:00.000Z',
  });
  const region = productStateReducer(empty, {
    type: 'UPDATE_PROFILE', profile: completeProfile, confirmedAt: '2026-10-04T00:00:01.000Z',
  });
  assert.strictEqual(empty, initial);
  assert.equal(region.personContextRevision, 1);
  assert.equal(region.userProfile.region?.countryCode, 'JP');
});

test('Observed signal confirm may merge confirmed context while dismiss never mutates PersonState', () => {
  const confirmedSignal: ObservedPersonSignal = {
    id: 'signal-confirm', proposedDomain: '興味', evidenceNodeIds: ['node-a'], sourceActions: ['KEEP'], status: 'pending', observedAt: '2026-10-04T00:00:00.000Z',
  };
  const dismissedSignal: ObservedPersonSignal = {
    id: 'signal-dismiss', proposedDomain: '制約', evidenceNodeIds: ['node-b'], sourceActions: ['PEEK'], status: 'pending', observedAt: '2026-10-04T00:00:01.000Z',
  };
  let state = createInitialProductState();
  state = productStateReducer(state, { type: 'ADD_OBSERVED_SIGNAL', signal: confirmedSignal });
  state = productStateReducer(state, { type: 'ADD_OBSERVED_SIGNAL', signal: dismissedSignal });
  state = productStateReducer(state, { type: 'CONFIRM_OBSERVED_SIGNAL', id: 'signal-confirm', contextField: 'interests', confirmedValue: '港の歴史' });
  const beforeDismiss = state.personState;
  state = productStateReducer(state, { type: 'DISMISS_OBSERVED_SIGNAL', id: 'signal-dismiss' });
  assert.deepEqual(state.personState.interests, ['港の歴史']);
  assert.equal(state.personContextRevision, 1);
  assert.strictEqual(state.personState, beforeDismiss);
  assert.equal(state.observedPersonSignals.find((signal) => signal.id === 'signal-confirm')?.status, 'confirmed');
  assert.equal(state.observedPersonSignals.find((signal) => signal.id === 'signal-dismiss')?.status, 'dismissed');
});

test('versioned repository round-trips canonical personal state', () => {
  const values = new Map<string, string>();
  const storage: BrowserStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const repository = createLocalStorageProductStateRepository(storage);
  const state = productStateReducer(createInitialProductState(), {
    type: 'CONFIRM_PERSON_CONTEXT',
    context: { ...context, recentChanges: ['外へ出る時間が増えた'] },
  });
  repository.save(persistedSnapshot(state));
  assert.equal(values.has(PRODUCT_STATE_STORAGE_KEY), true);
  assert.deepEqual(repository.load(), persistedSnapshot(state));
});

test('corrupted persistence falls back to a truly empty state', () => {
  const loaded = parsePersistedProductState('{not-json');
  assert.deepEqual(loaded, createEmptyPersistedProductState());
  assert.equal(loaded.personState.completedSteps.length, 0);
  assert.equal(loaded.personState.experiences.length, 0);
  assert.equal(loaded.onboardingComplete, false);
});

test('version 1 geography migrates only valid country codes and never invents a country', () => {
  const base = createEmptyPersistedProductState();
  const migrated = parsePersistedProductState(JSON.stringify({
    ...base,
    version: 1,
    onboardingComplete: true,
    userProfile: { nickname: 'クロ', region: { country: 'JP', prefecture: '東京都' }, updatedAt: '' },
  }));
  assert.deepEqual(migrated.userProfile.region, { countryCode: 'JP', administrativeArea: '東京都' });
  assert.equal(migrated.onboardingComplete, true);

  const unknownCountry = parsePersistedProductState(JSON.stringify({
    ...base,
    version: 1,
    onboardingComplete: true,
    userProfile: { nickname: 'クロ', region: { country: '日本', prefecture: '東京都' }, updatedAt: '' },
  }));
  assert.equal(unknownCountry.userProfile.region?.countryCode, undefined);
  assert.equal(unknownCountry.onboardingComplete, false);
});

test('normal Product route suppresses the legacy Goal form', () => {
  const source = readFileSync(new URL('../src/LivingFlowPilot.tsx', import.meta.url), 'utf8');
  assert.match(source, /!productView && <form className="living-goal-form"/u);
  assert.doesNotMatch(source, /目標・きっかけ/u);
});

test('Japanese is current UI language and English dictionary has every required key', () => {
  assert.equal(message('ja', 'profile.nickname'), 'ニックネーム');
  assert.equal(message('ja', 'nav.summary'), 'サマリー');
  assert.deepEqual(Object.keys(enMessages).sort(), Object.keys(jaMessages).sort());
  for (const key of Object.keys(jaMessages) as (keyof typeof jaMessages)[]) assert.ok(enMessages[key].trim().length > 0);
});

test('STEP_DONE updates the same canonical PersonState and preserves confirmed Summary context', () => {
  const initial = productStateReducer(createInitialProductState(), {
    type: 'CONFIRM_PERSON_CONTEXT',
    context: { ...context, interests: ['地域の物語'] },
  });
  const node = { id: 'node-a', title: '地域の記録', helpedByTags: [] } as unknown as PossibilityNode;
  const step: LocalSmallStep = {
    id: 'step-a', title: '古い写真を一枚調べる', shortDescription: '小さく調べる', portableResources: ['knowledge'], connectionTags: ['archive'], experienceTag: 'research',
  };
  const completed = completeLocalStep(initial.personState, node, step);
  const next = productStateReducer(initial, { type: 'REPLACE_PERSON_STATE', personState: completed });
  assert.deepEqual(next.personState.interests, ['地域の物語']);
  assert.deepEqual(next.personState.completedSteps, ['step-a']);
  assert.equal(next.personState.experiences[0].nodeId, 'node-a');
});
