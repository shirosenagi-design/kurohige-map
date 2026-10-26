import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCoverDestination } from '../src/coverRouting.ts';
import { message } from '../src/i18n.ts';
import { canStartInitialWorldGeneration, createProductGenerationContext } from '../src/generationContext.ts';
import { emptyPersonState } from '../src/livingFlow.ts';
import { readGenerationContext } from '../server/livingFlowApi.mjs';

const completeProfile = {
  nickname: 'クロ',
  region: { countryCode: 'JP', administrativeArea: '東京都' },
  updatedAt: '',
};

test('fresh Product mount owns a session-only closed Cover state', () => {
  const source = readFileSync(new URL('../src/ProductShell.tsx', import.meta.url), 'utf8');
  assert.match(source, /const \[coverEntered, setCoverEntered\] = useState\(false\)/u);
  assert.match(source, /!coverEntered && <CoverScreen/u);
  assert.doesNotMatch(source, /localStorage.*cover|sessionStorage.*cover/u);
});

test('Cover contains only its title and one entry action, without Product controls', () => {
  const source = readFileSync(new URL('../src/CoverScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /t\('cover\.title'\)/u);
  assert.match(source, /t\('cover\.open'\)/u);
  assert.match(source, /cover-background-no-cta\.png/u);
  assert.match(source, /cover-cta-button-base\.png/u);
  assert.doesNotMatch(source, /cover-sample-reference\.png/u);
  assert.match(source, /className="cover-compass"/u);
  assert.match(source, /className="cover-chevron"/u);
  assert.equal((source.match(/<button\b/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /<input\b|<textarea\b|<form\b|<nav\b|ProfileEditor|product-avatar|Goal|Context Seed/u);
  assert.doesNotMatch(source, /fetch\(/u);
});

test('first-run Cover CTA routes to Summary', () => {
  assert.equal(resolveCoverDestination({
    onboardingComplete: false,
    profile: { updatedAt: '' },
    world: { status: 'missing', hasWorld: false },
  }), 'summary');
});

test('incomplete required Profile routes to Summary even when onboarding flag is stale', () => {
  assert.equal(resolveCoverDestination({
    onboardingComplete: true,
    profile: { nickname: 'クロ', region: { countryCode: 'JP' }, updatedAt: '' },
    world: { status: 'ready', hasWorld: true },
  }), 'summary');
});

test('complete onboarding with missing or corrupt World routes to Summary', () => {
  assert.equal(resolveCoverDestination({ onboardingComplete: true, profile: completeProfile, world: { status: 'missing', hasWorld: false } }), 'summary');
  assert.equal(resolveCoverDestination({ onboardingComplete: true, profile: completeProfile, world: { status: 'corrupt', hasWorld: false } }), 'summary');
});

test('complete onboarding with a valid persisted World routes to Map', () => {
  assert.equal(resolveCoverDestination({ onboardingComplete: true, profile: completeProfile, world: { status: 'ready', hasWorld: true } }), 'map');
});

test('Cover CTA remains pending while IndexedDB World hydration is unresolved', () => {
  assert.equal(resolveCoverDestination({ onboardingComplete: true, profile: completeProfile, world: { status: 'hydrating', hasWorld: false } }), 'pending');
});

test('hydrating an existing World does not manufacture a new persistence revision', () => {
  const flow = readFileSync(new URL('../src/LivingFlowPilot.tsx', import.meta.url), 'utf8');
  assert.match(flow, /skipNextHydratedPersistenceRef\.current = true/u);
  assert.match(flow, /if \(skipNextHydratedPersistenceRef\.current\) \{\s*skipNextHydratedPersistenceRef\.current = false;\s*return;/u);
  assert.ok(flow.indexOf('if (skipNextHydratedPersistenceRef.current)') < flow.indexOf('const worldRevision = worldRevisionRef.current + 1'));
});

test('Japanese and English Cover strings resolve through the locale dictionary', () => {
  assert.equal(message('ja', 'cover.title'), 'KUROHIGE MAP');
  assert.equal(message('ja', 'cover.open'), '地図をひらく');
  assert.equal(message('en', 'cover.title'), 'KUROHIGE MAP');
  assert.equal(message('en', 'cover.open'), 'Open the map');
});

test('Product generation context is Person Map based and excludes nickname/avatar identity', () => {
  const context = createProductGenerationContext(emptyPersonState(), {
    nickname: 'クロ', avatarRef: 'private-avatar',
    region: { countryCode: 'JP', administrativeArea: '東京都' },
    occupation: '案内人', practicalProfile: ['週末'], updatedAt: '',
  }, 'ja');
  assert.equal(context.mode, 'person_map');
  assert.equal(context.contextSeed, null);
  assert.deepEqual(context.userProfile.region, { countryCode: 'JP', administrativeArea: '東京都' });
  assert.equal('nickname' in context.userProfile, false);
  assert.equal('avatarRef' in context.userProfile, false);
});

test('initial generation gate opens only for a completed onboarding with a missing empty World', () => {
  assert.equal(canStartInitialWorldGeneration({ status: 'missing', nodeCount: 0, onboardingComplete: true, profile: completeProfile }), true);
  assert.equal(canStartInitialWorldGeneration({ status: 'ready', nodeCount: 12, onboardingComplete: true, profile: completeProfile }), false);
  assert.equal(canStartInitialWorldGeneration({ status: 'corrupt', nodeCount: 0, onboardingComplete: true, profile: completeProfile }), false);
  assert.equal(canStartInitialWorldGeneration({ status: 'hydrating', nodeCount: 0, onboardingComplete: true, profile: completeProfile }), false);
});

test('server accepts the canonical Person Map contract without a parentGoal', () => {
  const parsed = readGenerationContext({ generationContext: createProductGenerationContext(emptyPersonState(), completeProfile, 'ja') });
  assert.equal(parsed.mode, 'person_map');
  assert.equal(parsed.contextSeed, '');
  assert.deepEqual(parsed.userProfile.region, { countryCode: 'JP', administrativeArea: '東京都' });
});

test('normal Product wiring issues one explicit initial generation command and keeps legacy Goal UI DEV-only', () => {
  const shell = readFileSync(new URL('../src/ProductShell.tsx', import.meta.url), 'utf8');
  const flow = readFileSync(new URL('../src/LivingFlowPilot.tsx', import.meta.url), 'utf8');
  assert.match(shell, /INITIAL_WORLD_GENERATION_REQUESTED/u);
  assert.match(flow, /initialWorldGenerationRequestId/u);
  assert.match(flow, /await worldRepositoryRef\.current!\.save\(snapshot\)/u);
  assert.match(flow, /!productView && <form className="living-goal-form"/u);
  assert.match(flow, /generationContext: createProductGenerationContext/u);
});
