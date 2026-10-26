import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocalEmailDelivery, createNebiusExperienceResolver, createNebiusReviewModerator, createReviewLabApi, createReviewLabRepository } from '../server/reviewLabApi.mjs';

const authorA = { userId: 'reviewer-a', role: 'user' };
const authorB = { userId: 'reviewer-b', role: 'user' };
const authorC = { userId: 'reviewer-c', role: 'user' };
const admin = { userId: 'review-admin', role: 'admin' };

test('local email delivery is an explicit isolated outbox and never impersonates production delivery', async () => {
  const delivery = createLocalEmailDelivery();
  assert.equal(delivery.kind, 'local-test');
  await delivery.sendMagicLink({ to: 'test@example.test', magicUrl: 'http://127.0.0.1/auth#token=secret', expiresAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(delivery.deliveries.length, 1);
  assert.equal(delivery.deliveries[0].to, 'test@example.test');
});

test('unconfigured production email delivery fails closed instead of reporting a fake send', async () => {
  const repository = { sessionStore: { startEmailChallenge() { throw new Error('must not be reached'); } } };
  const api = createReviewLabApi({ repository, productionMode: true, sessionSecret: 'test-secret', authPublicBaseUrl: 'https://map.example' });
  const result = await callMiddleware(api.middleware, {
    method: 'POST', url: '/auth/email/start', body: { email: 'test@example.test' }, origin: 'http://127.0.0.1:5173',
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'email_delivery_unavailable');
});

async function withStore(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kurohige-reviews-'));
  const storagePath = path.join(directory, 'reviews.json');
  try { await run(storagePath); } finally { await rm(directory, { recursive: true, force: true }); }
}

const draft = (overrides = {}) => ({
  subjectId: 'subject-action-read-galactic-railroad', sourceNodeId: 'personal-node-a',
  body: '実際に最後まで読み、想像していた冒険譚よりも孤独と他者への眼差しが強く残りました。次に読む人には急がず場面を味わってほしいです。',
  authorSnapshot: { age: 31, occupation: '編集者', shareAge: true, shareOccupation: false }, ...overrides,
});

async function approve(repository, reviewId, note = 'manual browser-equivalent moderation') {
  await repository.adminReviewAction(reviewId, admin, { action: 'approve', note });
}

async function grantLanding(repository, actor = authorA, nodeId = 'personal-node-a', subjectId = 'subject-action-read-galactic-railroad') {
  const requiredStepIds = [1, 2, 3].map((index) => `${nodeId}-step-${index}`);
  await repository.verifyNodeSubject(actor.userId, nodeId, subjectId, admin);
  await repository.startLandingJourney(nodeId, actor, { requiredStepIds });
  for (const stepId of requiredStepIds) await repository.completeLandingStep(nodeId, stepId, actor);
  return repository.commitLanding(nodeId, actor, {
    ownerNodeId: nodeId, ship: { x: 100, y: 100 }, ownerTarget: { x: 100, y: 100 },
  });
}

const sharedAction = (repository, {
  canonicalExperienceKey, name, action, object = '', setting = '', qualifiers = [], referenceLabel = '確認済みの行動・体験',
}) => repository.registerSharedActionSubject({
  name, referenceLabel, identity: { canonicalExperienceKey, action, object, setting, qualifiers },
}, admin);

function responseRecorder() {
  let resolveEnd;
  const ended = new Promise((resolve) => { resolveEnd = resolve; });
  return {
    statusCode: 0, headers: {}, body: '', ended,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(value = '') { this.body = String(value); resolveEnd(); },
  };
}

async function callMiddleware(middleware, { method = 'GET', url = '/', body, cookie, origin = 'http://127.0.0.1:5173' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:5173', origin, ...(cookie ? { cookie } : {}) }, socket: { encrypted: false } });
  const res = responseRecorder();
  await middleware(req, res); await res.ended;
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

test('catalog identifies actions and experiences rather than mentioned entities', () => {
  const api = createReviewLabApi({ storagePath: path.join(tmpdir(), 'unused-reviews.json'), developmentAuthEnabled: true });
  assert.ok(api.subjects.length >= 4);
  assert.ok(api.subjects.every((subject) => subject.id.startsWith('subject-action-')));
  assert.ok(api.subjects.every((subject) => subject.kind === 'action_experience' && subject.sharingScope === 'shared_confirmed'));
  assert.ok(api.subjects.some((subject) => subject.name === '『銀河鉄道の夜』を読む'));
  assert.equal(api.subjects.some((subject) => subject.id === 'personal-node-a'), false);
});

test('pending review persists across repository restart and remains invisible to another user', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository);
    const created = await repository.create(draft(), authorA);
    assert.equal(created.moderationStatus, 'pending_moderation');
    assert.deepEqual(await repository.listPublic(created.subjectId, authorB.userId), []);

    const restarted = createReviewLabRepository(storagePath);
    assert.deepEqual((await restarted.listByAuthor(authorA.userId)).map((review) => review.id), [created.id]);
    const stored = JSON.parse(await readFile(storagePath, 'utf8'));
    assert.equal(stored.reviews[0].authorId, authorA.userId);
    assert.equal(stored.reviews[0].sourceNodeId, 'personal-node-a');
  });
});

test('Phase 1 review data migrates without deleting the original review', async () => {
  await withStore(async (storagePath) => {
    const legacy = {
      version: 1,
      reviews: [{ id: 'review-legacy', subjectId: 'subject-book-galactic-railroad', sourceNodeId: 'legacy-node', authorId: 'legacy-author', body: '既存のPhase 1データを失わず、新しい審査状態へ安全に移行できることを確認するための本文です。', authorSnapshot: { age: 40, occupation: '司書' }, moderationStatus: 'pending_moderation', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: 1 }],
    };
    await writeFile(storagePath, JSON.stringify(legacy), 'utf8');
    const repository = createReviewLabRepository(storagePath);
    const [review] = await repository.listByAuthor('legacy-author');
    assert.equal(review.id, 'review-legacy');
    assert.equal(review.authorSnapshot.age, 40);
    await repository.bindNode('new-node', 'subject-book-galactic-railroad', authorA);
    assert.equal((await repository.readDatabaseForTest()).reviews[0].id, 'review-legacy');
    assert.equal((await repository.readDatabaseForTest()).reviews[0].subjectId, 'subject-book-galactic-railroad');
  });
});

test('public reviews are readable before landing while authoring remains locked', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository, authorA, 'author-node');
    const created = await repository.create(draft({ sourceNodeId: 'author-node' }), authorA);
    await approve(repository, created.id);
    await repository.verifyNodeSubject(authorB.userId, 'reader-node', created.subjectId, admin);

    assert.equal((await repository.listPublic(created.subjectId, authorB.userId)).length, 1);
    const context = await repository.nodeReviewContext('reader-node', authorB);
    assert.equal(context.subject.id, created.subjectId);
    assert.equal(context.eligibility.canPost, false);
    assert.equal(context.eligibility.reason, 'landing_required');
    await assert.rejects(
      repository.create(draft({ sourceNodeId: 'reader-node', landed: true }), authorB),
      (error) => error?.status === 403 && error?.code === 'review_landing_required',
    );
  });
});

test('server landing ledger requires verified subject, exactly three recorded steps, owner and radius', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    const nodeId = 'canonical-node-a';
    const steps = ['step-one', 'step-two', 'step-three'];
    await assert.rejects(repository.startLandingJourney(nodeId, authorA, { requiredStepIds: steps }), (error) => error?.code === 'subject_not_verified');
    await repository.verifyNodeSubject(authorA.userId, nodeId, 'subject-action-attend-comiket', admin);
    await repository.startLandingJourney(nodeId, authorA, { requiredStepIds: steps });
    await repository.completeLandingStep(nodeId, steps[0], authorA);
    await repository.completeLandingStep(nodeId, steps[1], authorA);
    await assert.rejects(repository.commitLanding(nodeId, authorA, { ownerNodeId: nodeId, ship: { x: 0, y: 0 }, ownerTarget: { x: 0, y: 0 } }), (error) => error?.code === 'landing_steps_incomplete');
    await repository.completeLandingStep(nodeId, steps[2], authorA);
    assert.throws(() => repository.commitLanding(nodeId, authorA, { ownerNodeId: 'forged-owner', ship: { x: 0, y: 0 }, ownerTarget: { x: 0, y: 0 } }), (error) => error?.code === 'invalid_landing_evidence');
    await assert.rejects(repository.commitLanding(nodeId, authorA, { ownerNodeId: nodeId, ship: { x: 0, y: 0 }, ownerTarget: { x: 500, y: 500 } }), (error) => error?.code === 'landing_radius_not_reached');
    await repository.commitLanding(nodeId, authorA, { ownerNodeId: nodeId, ship: { x: 20, y: 20 }, ownerTarget: { x: 20, y: 20 } });
    assert.equal((await repository.nodeReviewContext(nodeId, authorA)).eligibility.canPost, true);
  });
});

test('server landing ledger accepts a canonical sea berth and rejects forged navigation anchors', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    const nodeId = 'navigation-berth-node';
    const steps = ['step-one', 'step-two', 'step-three'];
    await repository.verifyNodeSubject(authorA.userId, nodeId, 'subject-action-attend-comiket', admin);
    await repository.startLandingJourney(nodeId, authorA, { requiredStepIds: steps });
    for (const stepId of steps) await repository.completeLandingStep(nodeId, stepId, authorA);
    const ownerTarget = { x: 0, y: 0 };
    const landingAnchor = { x: 198.5, y: 0 };
    assert.throws(
      () => repository.commitLanding(nodeId, authorA, {
        ownerNodeId: nodeId,
        ship: landingAnchor,
        ownerTarget,
        landingAnchor: { x: 500, y: 0 },
        navigationVersion: 1,
      }),
      (error) => error?.code === 'invalid_landing_evidence',
    );
    const landed = await repository.commitLanding(nodeId, authorA, {
      ownerNodeId: nodeId,
      ship: landingAnchor,
      ownerTarget,
      landingAnchor,
      navigationVersion: 1,
    });
    assert.equal(landed.landingEvidence.navigationVersion, 1);
    assert.deepEqual(landed.landingEvidence.ownerTarget, ownerTarget);
    assert.deepEqual(landed.landingEvidence.landingAnchor, landingAnchor);
    assert.equal(landed.landingEvidence.distance, 0);
  });
});

test('landing on another node never grants review authoring for the requested node', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository, authorA, 'landed-elsewhere');
    await repository.verifyNodeSubject(authorA.userId, 'requested-node', 'subject-action-read-galactic-railroad', admin);
    await assert.rejects(
      repository.create(draft({ sourceNodeId: 'requested-node', landed: true }), authorA),
      (error) => error?.status === 403 && error?.code === 'review_landing_required',
    );
  });
});

test('verified landing qualification and pending review survive repository restart', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository);
    const created = await repository.create(draft(), authorA);
    const restarted = createReviewLabRepository(storagePath);
    assert.equal((await restarted.nodeReviewContext('personal-node-a', authorA)).eligibility.canPost, true);
    assert.equal((await restarted.listByAuthor(authorA.userId))[0].id, created.id);
    assert.equal((await restarted.listByAuthor(authorA.userId))[0].moderationStatus, 'pending_moderation');
  });
});

test('the moderation worker publishes only the completed moderation result', async () => {
  await withStore(async (storagePath) => {
    const moderator = { available: true, calls: 0, async moderate() { this.calls += 1; return { outcome: 'complete', decision: 'approved', reason: 'safe lived experience', policyLabels: ['safe'], model: 'mock-nemotron' }; } };
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, moderator });
    await grantLanding(api.repository);
    const created = await api.repository.create(draft(), authorA);
    assert.deepEqual(await api.repository.listPublic(created.subjectId, authorB.userId), []);
    assert.deepEqual(await api.processNextModeration(), { status: 'complete', reviewId: created.id, decision: 'approved' });
    assert.equal(moderator.calls, 1);
    assert.equal((await api.repository.listPublic(created.subjectId, authorB.userId)).length, 1);
  });
});

test('public projection exposes only opted-in age or occupation and never internal identity fields', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository);
    const first = await repository.create(draft(), authorA); await approve(repository, first.id);
    const [published] = await repository.listPublic(first.subjectId, authorB.userId);
    assert.equal(published.authorSnapshot.age, 31);
    assert.equal(published.authorSnapshot.occupation, null);
    assert.equal('authorId' in published, false);
    assert.equal('sourceNodeId' in published, false);
    assert.equal('moderation' in published, false);
  });
});

test('ownership is enforced, author edit returns content to private re-moderation', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository);
    const created = await repository.create(draft(), authorA); await approve(repository, created.id);
    await assert.rejects(repository.update(created.id, { body: '他人による不正な編集を試すための十分に長い本文です。' }, authorB), (error) => error?.code === 'author_mismatch');
    const edited = await repository.update(created.id, { body: '再読すると最初とは違う場面が残り、次に読む人へ伝えたい点も変わったため本文を更新しました。' }, authorA);
    assert.equal(edited.revision, 2); assert.equal(edited.moderationStatus, 'pending_moderation');
    assert.deepEqual(await repository.listPublic(created.subjectId, authorB.userId), []);
  });
});

test('helpful is one vote per user, removable, and report requires admin review without auto-hiding', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository);
    const created = await repository.create(draft(), authorA); await approve(repository, created.id);
    assert.equal((await repository.setHelpful(created.id, authorB, true)).helpfulCount, 1);
    assert.equal((await repository.setHelpful(created.id, authorB, true)).helpfulCount, 1);
    assert.equal((await repository.setHelpful(created.id, authorB, false)).helpfulCount, 0);
    const report = await repository.report(created.id, authorB, { reason: 'other', details: '文脈を管理者に確認してほしい' });
    assert.equal(report.status, 'open');
    assert.equal((await repository.listPublic(created.subjectId, authorB.userId)).length, 1);
    assert.equal((await repository.adminQueue()).reports.length, 1);
    await repository.resolveReport(report.id, admin, { resolution: '確認済み' });
    assert.equal((await repository.adminQueue()).reports.length, 0);
    assert.equal((await repository.listPublic(created.subjectId, authorB.userId)).length, 1);
  });
});

test('same confirmed action experience is shared across different personal nodes without title-based merging', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await repository.verifyNodeSubject(authorA.userId, 'map-a-node-14', 'subject-action-attend-comiket', admin);
    await repository.verifyNodeSubject(authorB.userId, 'map-b-node-92', 'subject-action-attend-comiket', admin);
    assert.equal((await repository.nodeReviewContext('map-a-node-14', authorA)).subject.id, 'subject-action-attend-comiket');
    assert.equal((await repository.nodeReviewContext('map-b-node-92', authorB)).subject.id, 'subject-action-attend-comiket');
    assert.equal((await repository.nodeReviewContext('map-a-node-14', authorB)).subject, null);
    await assert.rejects(repository.verifyNodeSubject(authorA.userId, 'unknown-node', 'title-derived-fiction', admin), (error) => error?.code === 'unknown_subject');
    await assert.rejects(
      repository.create(draft({ sourceNodeId: 'map-a-node-14', subjectId: 'subject-action-read-galactic-railroad' }), authorA),
      (error) => error?.code === 'review_landing_required',
    );
  });
});

test('same place with different actions creates different review subjects', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    const visit = await sharedAction(repository, {
      canonicalExperienceKey: 'visit-park:ueno:walking', name: '上野公園を訪れる', action: 'visit', object: 'park', setting: 'ueno-park', qualifiers: ['walk'],
    });
    const publishGuide = await sharedAction(repository, {
      canonicalExperienceKey: 'create-sell-guide:ueno:nature', name: '上野公園で自然観察ガイドを制作・販売する', action: 'create-and-sell', object: 'nature-observation-guide', setting: 'ueno-park', qualifiers: ['publish'],
    });
    const hostEvent = await sharedAction(repository, {
      canonicalExperienceKey: 'host-event:ueno', name: '上野公園でイベントを開催する', action: 'host', object: 'event', setting: 'ueno-park', qualifiers: ['organize'],
    });
    assert.equal(new Set([visit.id, publishGuide.id, hostEvent.id]).size, 3);
    assert.ok([visit, publishGuide, hostEvent].every((subject) => subject.identity.setting === 'ueno-park'));
  });
});

test('different users share reviews only after the same action identity is explicitly confirmed', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    const identity = {
      canonicalExperienceKey: 'make-sell-nature-guide:ueno:v1', name: '上野公園で自然観察ガイドを制作・販売する',
      action: 'create-and-sell', object: 'nature-observation-guide', setting: 'ueno-park', qualifiers: ['publish'],
    };
    const first = await sharedAction(repository, identity);
    const confirmedAgain = await sharedAction(repository, identity);
    assert.equal(confirmedAgain.id, first.id);
    await repository.verifyNodeSubject(authorA.userId, 'map-a-guide', first.id, admin);
    await repository.verifyNodeSubject(authorB.userId, 'map-b-guide', first.id, admin);
    assert.equal((await repository.nodeReviewContext('map-a-guide', authorA)).subject.id, first.id);
    assert.equal((await repository.nodeReviewContext('map-b-guide', authorB)).subject.id, first.id);
  });
});

test('an island without a place gets a review subject but ambiguous matches stay island-specific', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    const candidate = { name: '短編アニメーションを制作する', summary: '小さな物語を映像作品にする。', category: '表現', nodeKind: 'activity' };
    const steps = ['animation-step-1', 'animation-step-2', 'animation-step-3'];
    await repository.startLandingJourney('animation-node-a', authorA, { requiredStepIds: steps, subjectCandidate: candidate });
    const islandA = { subject: (await repository.nodeReviewContext('animation-node-a', authorA)).subject };
    const islandB = await repository.ensureIslandSubject('animation-node-b', candidate, authorB);
    assert.equal(islandA.subject.kind, 'action_experience');
    assert.equal(islandA.subject.sharingScope, 'island_specific');
    assert.notEqual(islandA.subject.id, islandB.subject.id);

    for (const stepId of steps) await repository.completeLandingStep('animation-node-a', stepId, authorA);
    await repository.commitLanding('animation-node-a', authorA, { ownerNodeId: 'animation-node-a', ship: { x: 10, y: 10 }, ownerTarget: { x: 10, y: 10 } });
    const created = await repository.create(draft({ subjectId: islandA.subject.id, sourceNodeId: 'animation-node-a' }), authorA);
    assert.equal(created.moderationStatus, 'pending_moderation');
    assert.equal((await repository.nodeReviewContext('animation-node-b', authorB)).eligibility.canPost, false);
  });
});

test('cross-user resolver shares paraphrased experiences, separates same-place actions, and preserves uncertainty', async () => {
  await withStore(async (storagePath) => {
    const calls = [];
    const resolver = {
      available: true,
      async resolve(candidate, candidates) {
        calls.push({ candidate: structuredClone(candidate), candidateIds: candidates.map((entry) => entry.id) });
        const aiMusic = candidates.find((entry) => entry.identity?.object === 'ai-generated-music' && entry.identity?.setting === 'youtube');
        if (candidate.name.includes('AI作曲')) return {
          outcome: 'complete', decision: 'same', confidence: 'high', matchedSubjectId: aiMusic?.id ?? '',
          reason: 'Both propose publishing one AI-created song to YouTube.',
          identity: { action: 'publish', object: 'ai-generated-music', setting: 'youtube', qualifiers: ['single-upload'], purpose: 'share-music', constraints: [] }, model: 'mock-nemotron',
        };
        if (candidate.name.includes('何か面白い')) return {
          outcome: 'complete', decision: 'uncertain', confidence: 'low', matchedSubjectId: '', reason: 'The concrete action and outcome are unspecified.',
          identity: { action: 'explore', object: '', setting: '', qualifiers: [], purpose: '', constraints: [] }, model: 'mock-nemotron',
        };
        if (candidate.name.includes('自然観察ガイド')) return {
          outcome: 'complete', decision: 'different', confidence: 'high', matchedSubjectId: '', reason: 'Creating and selling a guide is different from visiting the same park.',
          identity: { action: 'create-and-sell', object: 'nature-observation-guide', setting: 'ueno-park', qualifiers: ['publish'], purpose: 'offer-guide', constraints: [] }, model: 'mock-nemotron',
        };
        return {
          outcome: 'complete', decision: 'different', confidence: 'high', matchedSubjectId: '', reason: 'No existing subject proposes this action.',
          identity: { action: 'publish', object: 'ai-generated-music', setting: 'youtube', qualifiers: ['single-upload'], purpose: 'share-music', constraints: [] }, model: 'mock-nemotron',
        };
      },
    };
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, experienceResolver: resolver });
    const candidateA = { name: 'AIで作った楽曲をYouTubeに公開する', summary: 'AI作曲した一曲を動画にして公開し、反応を確かめる。', category: '音楽', nodeKind: 'project', portableResourceTags: ['publishing'], connectionTags: ['music'], helpedByTags: ['creative-output'] };
    const candidateB = { ...candidateA, name: 'AI作曲した曲をYouTubeへ投稿してみる', summary: '生成AIで作曲した曲を一本の動画としてYouTubeへ投稿する。' };
    const resultA = await api.resolveExperienceSubject('music-node-a', candidateA, authorA);
    const resultB = await api.resolveExperienceSubject('music-node-b', candidateB, authorB);
    assert.equal(resultA.subject.sharingScope, 'shared_confirmed');
    assert.equal(resultB.subject.id, resultA.subject.id);
    assert.equal(resultB.resolution.decision, 'same');

    const uenoGuide = await api.resolveExperienceSubject('ueno-guide-c', {
      name: '上野公園で自然観察ガイドを制作・販売する', summary: '現地で観察した情報をガイドにまとめて販売する。', category: '出版', nodeKind: 'project',
    }, authorC);
    assert.notEqual(uenoGuide.subject.id, 'subject-action-visit-ueno-park');
    assert.equal(uenoGuide.resolution.decision, 'different');

    const ambiguous = await api.resolveExperienceSubject('uncertain-node-c', {
      name: '何か面白いことを試す', summary: 'まだ方法も成果物も決めていない。', category: '未定', nodeKind: 'idea',
    }, authorC);
    assert.equal(ambiguous.subject.sharingScope, 'island_specific');
    assert.equal(ambiguous.resolution.decision, 'uncertain');

    const callsBeforeCache = calls.length;
    const cached = await api.resolveExperienceSubject('music-node-cache', candidateA, authorC);
    assert.equal(cached.subject.id, resultA.subject.id);
    assert.equal(calls.length, callsBeforeCache);

    const restarted = createReviewLabApi({ storagePath, developmentAuthEnabled: true, experienceResolver: resolver });
    assert.equal((await restarted.repository.nodeReviewContext('music-node-b', authorB)).subject.id, resultA.subject.id);
    assert.equal((await restarted.repository.nodeReviewContext('uncertain-node-c', authorC)).subject.id, ambiguous.subject.id);
    assert.ok((await restarted.repository.listExperienceResolutions()).some((entry) => entry.nodeId === 'music-node-b' && entry.reason.includes('publishing')));
  });
});

test('resolved subject shares only approved voyage logs and keeps landing eligibility personal', async () => {
  await withStore(async (storagePath) => {
    const resolver = {
      available: true,
      async resolve(candidate, candidates) {
        const existing = candidates.find((entry) => entry.identity?.object === 'ai-generated-music');
        return existing
          ? { outcome: 'complete', decision: 'same', confidence: 'high', matchedSubjectId: existing.id, reason: 'Same publish action, object, setting, and purpose.', identity: existing.identity, model: 'mock-nemotron' }
          : { outcome: 'complete', decision: 'different', confidence: 'high', matchedSubjectId: '', reason: 'New concrete experience.', identity: { action: 'publish', object: 'ai-generated-music', setting: 'youtube', qualifiers: [], purpose: 'share-music', constraints: [] }, model: 'mock-nemotron' };
      },
    };
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, experienceResolver: resolver });
    const candidate = { name: 'AI作曲した曲をYouTubeへ投稿する', summary: '一曲を動画として公開する。', category: '音楽', nodeKind: 'project' };
    const subjectA = (await api.resolveExperienceSubject('shared-node-a', candidate, authorA)).subject;
    const subjectB = (await api.resolveExperienceSubject('shared-node-b', { ...candidate, name: 'AIで作った楽曲をYouTubeに公開する' }, authorB)).subject;
    assert.equal(subjectB.id, subjectA.id);

    await assert.rejects(api.repository.create(draft({ subjectId: subjectB.id, sourceNodeId: 'shared-node-b' }), authorB), (error) => error?.code === 'review_landing_required');
    for (const [actor, nodeId] of [[authorA, 'shared-node-a'], [authorB, 'shared-node-b']]) {
      const steps = [1, 2, 3].map((index) => `${nodeId}-step-${index}`);
      await api.repository.startLandingJourney(nodeId, actor, { requiredStepIds: steps });
      for (const stepId of steps) await api.repository.completeLandingStep(nodeId, stepId, actor);
      await api.repository.commitLanding(nodeId, actor, { ownerNodeId: nodeId, ship: { x: 20, y: 20 }, ownerTarget: { x: 20, y: 20 } });
    }
    const pending = await api.repository.create(draft({ subjectId: subjectA.id, sourceNodeId: 'shared-node-a', body: 'AIで作った一曲を動画へまとめ、公開設定や説明文を整えて投稿しました。反応を見る前に音量確認が必要だと学びました。' }), authorA);
    assert.deepEqual(await api.repository.listPublic(subjectA.id, authorB.userId), []);
    await approve(api.repository, pending.id);
    assert.deepEqual((await api.repository.listPublic(subjectB.id, authorB.userId)).map((entry) => entry.id), [pending.id]);
    const createdB = await api.repository.create(draft({ subjectId: subjectB.id, sourceNodeId: 'shared-node-b', body: '自分でもAI作曲した一曲をYouTubeへ投稿し、公開前の確認手順と説明文づくりを体験しました。' }), authorB);
    assert.equal(createdB.moderationStatus, 'pending_moderation');
  });
});

test('legacy island-specific voyage logs connect through a reversible alias without rewriting history', async () => {
  await withStore(async (storagePath) => {
    const initial = createReviewLabRepository(storagePath);
    const candidateA = { name: 'AIで作った楽曲をYouTubeに公開する', summary: 'AI作曲した一曲を動画にして公開する。', category: '音楽', nodeKind: 'project' };
    const island = await initial.ensureIslandSubject('legacy-music-node-a', candidateA, authorA);
    const steps = ['legacy-a-step-1', 'legacy-a-step-2', 'legacy-a-step-3'];
    await initial.startLandingJourney('legacy-music-node-a', authorA, { requiredStepIds: steps });
    for (const stepId of steps) await initial.completeLandingStep('legacy-music-node-a', stepId, authorA);
    await initial.commitLanding('legacy-music-node-a', authorA, { ownerNodeId: 'legacy-music-node-a', ship: { x: 0, y: 0 }, ownerTarget: { x: 0, y: 0 } });
    const published = await initial.create(draft({ subjectId: island.subject.id, sourceNodeId: 'legacy-music-node-a', body: '以前から保存されている公開済み航海日誌です。本文や所有者を変更せず、新しい共有subjectから読めるかを確認します。' }), authorA);
    await approve(initial, published.id);
    const pending = await initial.create(draft({ subjectId: island.subject.id, sourceNodeId: 'legacy-music-node-a', body: '審査中の航海日誌が別ユーザーへ漏れないことを確認するための隔離テスト本文です。' }), authorA);
    const before = await initial.readDatabaseForTest();

    const resolver = {
      available: true,
      async resolve(_candidate, candidates) {
        const legacy = candidates.find((entry) => entry.id === island.subject.id);
        assert.ok(legacy);
        return { outcome: 'complete', decision: 'same', confidence: 'high', matchedSubjectId: legacy.id, reason: 'Both propose publishing one AI-created song to YouTube.', identity: { action: 'publish', object: 'ai-generated-music', setting: 'youtube', qualifiers: [], purpose: 'share-music', constraints: [] }, model: 'mock-nemotron' };
      },
    };
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, experienceResolver: resolver });
    const resolvedB = await api.resolveExperienceSubject('new-music-node-b', { ...candidateA, name: 'AI作曲した曲をYouTubeへ投稿する' }, authorB);
    assert.equal(resolvedB.subject.sharingScope, 'shared_confirmed');
    assert.notEqual(resolvedB.subject.id, island.subject.id);
    const visibleToB = await api.repository.listPublic(resolvedB.subject.id, authorB.userId);
    assert.deepEqual(visibleToB.map((entry) => entry.id), [published.id]);
    assert.equal(visibleToB.some((entry) => entry.id === pending.id), false);

    const linked = await api.repository.readDatabaseForTest();
    const beforeReviews = before.reviews.map(({ id, subjectId, sourceNodeId, authorId, body, moderationStatus, revision }) => ({ id, subjectId, sourceNodeId, authorId, body, moderationStatus, revision }));
    const afterReviews = linked.reviews.map(({ id, subjectId, sourceNodeId, authorId, body, moderationStatus, revision }) => ({ id, subjectId, sourceNodeId, authorId, body, moderationStatus, revision }));
    assert.deepEqual(afterReviews, beforeReviews);
    assert.deepEqual(linked.landingJourneys, before.landingJourneys);
    assert.deepEqual(linked.verifiedNodeSubjects.find((entry) => entry.userId === authorA.userId), before.verifiedNodeSubjects.find((entry) => entry.userId === authorA.userId));
    assert.equal(linked.experienceSubjectLinks.filter((entry) => entry.status === 'active').length, 1);

    const restarted = createReviewLabRepository(storagePath);
    assert.deepEqual((await restarted.listPublic(resolvedB.subject.id, authorB.userId)).map((entry) => entry.id), [published.id]);
    const correction = await restarted.correctNodeSubject(authorA.userId, 'legacy-music-node-a', { mode: 'isolate', reason: 'TEST 誤った共有対応付けを解除する' }, admin);
    assert.deepEqual(correction.movedReviewIds, []);
    assert.deepEqual(await restarted.listPublic(resolvedB.subject.id, authorB.userId), []);
    assert.deepEqual((await restarted.listPublic(island.subject.id, authorA.userId)).map((entry) => entry.id), [published.id]);
    const corrected = await restarted.readDatabaseForTest();
    assert.deepEqual(corrected.reviews.map(({ id, subjectId, sourceNodeId, authorId, body, moderationStatus, revision }) => ({ id, subjectId, sourceNodeId, authorId, body, moderationStatus, revision })), beforeReviews);
    assert.ok(corrected.auditLog.some((entry) => entry.action === 'resolver.subject_corrected'));
  });
});

test('Nebius experience resolver uses strict three-state structured output and reports usage', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'nvidia/Nemotron-3-Ultra-550b-a55b' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'same', confidence: 'high', matchedSubjectId: 'subject-action-test', reason: 'The action, object, setting, and purpose are identical.', identity: { action: 'publish', object: 'ai-generated-music', setting: 'youtube', qualifiers: [], purpose: 'share-music', constraints: [] } }) } }],
      usage: { prompt_tokens: 500, completion_tokens: 90, total_tokens: 590, completion_tokens_details: { reasoning_tokens: 0 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const resolver = createNebiusExperienceResolver({ apiKey: 'mock-key', apiEnabled: true, fetchImpl });
  const result = await resolver.resolve({ name: 'AI作曲した曲をYouTubeへ投稿する', summary: '', category: '', nodeKind: '', semanticTags: [] }, [{ id: 'subject-action-test', name: 'AI楽曲をYouTubeに公開する', referenceLabel: '', identity: { action: 'publish', object: 'ai-generated-music', setting: 'youtube', qualifiers: [], purpose: 'share-music', constraints: [] } }]);
  assert.equal(requests.length, 2);
  const requestBody = JSON.parse(requests[1].init.body);
  assert.equal(requestBody.response_format.json_schema.strict, true);
  assert.deepEqual(requestBody.response_format.json_schema.schema.properties.decision.enum, ['same', 'different', 'uncertain']);
  assert.equal(requestBody.chat_template_kwargs.enable_thinking, false);
  assert.equal(result.decision, 'same');
  assert.deepEqual(result.diagnostic.usage, { promptTokens: 500, completionTokens: 90, totalTokens: 590, reasoningTokens: 0 });
});

test('large registry path normalizes identity first and reuses an exact match with one resolver call', async () => {
  await withStore(async (storagePath) => {
    const canonical = { identityVersion: 2, action: 'publish', object: 'ai-generated-music', setting: 'youtube', qualifiers: [], purpose: 'share-music', constraints: [] };
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const target = { id: 'subject-action-large-target', kind: 'action_experience', name: 'AI楽曲をYouTubeに公開する', referenceLabel: '一曲を公開する体験', sharingScope: 'shared_confirmed', identityVersion: 2, canonicalExperienceKey: `auto-v2:${fingerprint.slice(0, 32)}`, identity: { ...canonical, fingerprint } };
    const distractors = Array.from({ length: 100 }, (_, index) => ({ id: `subject-action-large-${index}`, kind: 'action_experience', name: `TEST 別の体験${index}`, referenceLabel: 'TEST unrelated', sharingScope: 'shared_confirmed', identityVersion: 2, canonicalExperienceKey: `test:${index}`, identity: { action: `other-${index}`, object: `object-${index}`, setting: '', qualifiers: ['publishing'], purpose: `other-${index}`, constraints: [], fingerprint: `other-${index}` } }));
    await writeFile(storagePath, JSON.stringify({ version: 6, reviews: [], helpfulVotes: [], reports: [], users: [], bindings: [], reviewSubjects: [...distractors, target], verifiedNodeSubjects: [], landingJourneys: [], moderationJobs: [], experienceResolutions: [], experienceSubjectLinks: [], subjectCorrections: [], auditLog: [] }), 'utf8');
    const calls = { extract: 0, compare: 0 };
    const resolver = {
      available: true,
      async extractIdentity() { calls.extract += 1; return { outcome: 'complete', identity: canonical, model: 'mock-nemotron', diagnostic: { finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, reasoningTokens: 0 } } }; },
      async resolve() { calls.compare += 1; throw new Error('Exact identity must not need a comparison call.'); },
    };
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, experienceResolver: resolver });
    const result = await api.resolveExperienceSubject('large-node', { name: 'AIで作った曲を動画サイトへ投稿する', summary: '一曲をYouTubeで公開する。', category: '音楽', nodeKind: 'project' }, authorA);
    assert.equal(result.subject.id, target.id);
    assert.deepEqual(calls, { extract: 1, compare: 0 });
    assert.equal(result.resolution.method, 'identity_exact');
  });
});

test('Nebius identity extraction uses a bounded strict schema before large-registry retrieval', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'nvidia/Nemotron-3-Ultra-550b-a55b' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ identity: { action: 'publish', object: 'ai-generated-music', setting: 'youtube', qualifiers: [], purpose: 'share-music', constraints: [] } }) } }],
      usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250, completion_tokens_details: { reasoning_tokens: 0 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const resolver = createNebiusExperienceResolver({ apiKey: 'mock-key', apiEnabled: true, fetchImpl });
  const result = await resolver.extractIdentity({ name: 'AI作曲した曲をYouTubeへ投稿する', summary: '', category: '', nodeKind: '', semanticTags: [] });
  assert.equal(requests.length, 2);
  const body = JSON.parse(requests[1].init.body);
  assert.equal(body.response_format.json_schema.name, 'experience_identity');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.max_tokens, 700);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.equal(result.identity.object, 'ai-generated-music');
});

test('paused island subjects can later resolve safely, while landed review history requires explicit correction', async () => {
  await withStore(async (storagePath) => {
    const candidate = { name: 'AI楽曲をYouTubeに公開する', summary: 'AIで作った一曲を動画として投稿する。', category: '音楽', nodeKind: 'project' };
    const pausedApi = createReviewLabApi({ storagePath, developmentAuthEnabled: true, experienceResolver: { available: false } });
    const isolated = await pausedApi.resolveExperienceSubject('upgrade-node', candidate, authorA);
    assert.equal(isolated.subject.sharingScope, 'island_specific');
    assert.equal(isolated.resolution.method, 'paused');

    const resolver = {
      available: true,
      async resolve() {
        return { outcome: 'complete', decision: 'different', confidence: 'high', matchedSubjectId: '', reason: 'A concrete new publish experience.', identity: { action: 'publish', object: 'ai-generated-music', setting: 'youtube', qualifiers: [], purpose: 'share-music', constraints: [] }, model: 'mock-nemotron' };
      },
    };
    const resumedApi = createReviewLabApi({ storagePath, developmentAuthEnabled: true, experienceResolver: resolver });
    const upgraded = await resumedApi.resolveExperienceSubject('upgrade-node', candidate, authorA);
    assert.equal(upgraded.subject.sharingScope, 'shared_confirmed');
    assert.notEqual(upgraded.subject.id, isolated.subject.id);

    const historical = await resumedApi.resolveExperienceSubject('history-node', { ...candidate, name: 'AI作曲を動画サイトへ公開する' }, authorB);
    const steps = ['history-step-1', 'history-step-2', 'history-step-3'];
    await resumedApi.repository.startLandingJourney('history-node', authorB, { requiredStepIds: steps });
    for (const stepId of steps) await resumedApi.repository.completeLandingStep('history-node', stepId, authorB);
    await resumedApi.repository.commitLanding('history-node', authorB, { ownerNodeId: 'history-node', ship: { x: 0, y: 0 }, ownerTarget: { x: 0, y: 0 } });
    const review = await resumedApi.repository.create(draft({ subjectId: historical.subject.id, sourceNodeId: 'history-node' }), authorB);
    const before = structuredClone((await resumedApi.repository.readDatabaseForTest()).reviews.find((entry) => entry.id === review.id));
    const correction = await resumedApi.repository.correctNodeSubject(authorB.userId, 'history-node', { mode: 'isolate', reason: '監査で異なる体験と確認したため共有を解除' }, admin);
    const after = (await resumedApi.repository.readDatabaseForTest()).reviews.find((entry) => entry.id === review.id);
    assert.notEqual(correction.subjectId, correction.previousSubjectId);
    assert.equal(after.body, before.body);
    assert.equal(after.authorId, before.authorId);
    assert.equal(after.moderationStatus, before.moderationStatus);
    assert.equal(after.subjectId, correction.subjectId);
    assert.ok((await resumedApi.repository.auditLog()).some((entry) => entry.action === 'resolver.subject_corrected' && entry.targetId === 'history-node'));
  });
});

test('administrator freeze blocks new posts, edits, helpful and reports and records audit actions', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository);
    const created = await repository.create(draft(), authorA); await approve(repository, created.id);
    await repository.freezeUser(authorA.userId, admin, { frozen: true, reason: 'repeated policy violation' });
    await assert.rejects(repository.create(draft({ sourceNodeId: 'second-node' }), authorA), (error) => error?.code === 'review_access_frozen');
    await assert.rejects(repository.update(created.id, { body: '凍結中の編集はサーバー側で拒否される必要があるための長い本文です。' }, authorA), (error) => error?.code === 'review_access_frozen');
    await assert.rejects(repository.setHelpful(created.id, authorA, true), (error) => error?.code === 'review_access_frozen');
    assert.ok((await repository.auditLog()).some((entry) => entry.action === 'admin.user.frozen'));
  });
});

test('paused Nebius guard makes zero external requests and leaves moderation pending', async () => {
  await withStore(async (storagePath) => {
    let externalCalls = 0;
    const moderator = createNebiusReviewModerator({ apiKey: 'never-sent', apiEnabled: false, fetchImpl: async () => { externalCalls += 1; throw new Error('must not run'); } });
    const api = createReviewLabApi({ storagePath, moderator, developmentAuthEnabled: true });
    await grantLanding(api.repository);
    const created = await api.repository.create(draft(), authorA);
    assert.deepEqual(await api.processNextModeration(), { status: 'paused' });
    assert.equal(externalCalls, 0);
    assert.equal((await api.repository.listByAuthor(authorA.userId))[0].moderationStatus, 'pending_moderation');
    const database = await api.repository.readDatabaseForTest();
    assert.equal(database.moderationJobs[0].attempts, 0);
    assert.equal(database.moderationJobs[0].lastError, 'API_PAUSED');
    assert.equal(created.id, database.reviews[0].id);
  });
});

test('Nebius moderation uses the Token Factory endpoint with its supported strict schema and reports usage', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'nvidia/Nemotron-3-Ultra-550b-a55b' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'approved', reason: 'safe', policyLabels: ['safe'] }) } }],
      usage: { prompt_tokens: 191, completion_tokens: 40, total_tokens: 231, completion_tokens_details: { reasoning_tokens: 0 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const moderator = createNebiusReviewModerator({ apiKey: 'mock-key', apiEnabled: true, fetchImpl });
  const result = await moderator.moderate({ body: '安全な体験レビュー本文です。' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.tokenfactory.nebius.com/v1/models');
  assert.equal(requests[1].url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
  const requestBody = JSON.parse(requests[1].init.body);
  assert.equal(requestBody.response_format.json_schema.strict, true);
  assert.equal('uniqueItems' in requestBody.response_format.json_schema.schema.properties.policyLabels, false);
  assert.deepEqual(result.diagnostic, {
    finishReason: 'stop',
    usage: { promptTokens: 191, completionTokens: 40, totalTokens: 231, reasoningTokens: 0 },
  });
});

test('bounded moderation failures move content to human review after three attempts', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository);
    await repository.create(draft(), authorA);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = await repository.claimModerationJob(new Date(`2030-01-0${attempt + 1}T00:00:00.000Z`));
      assert.ok(claim); await repository.failModeration(claim.job.id, 'temporary moderation failure', new Date(`2030-01-0${attempt + 1}T00:00:00.000Z`));
    }
    assert.equal((await repository.listByAuthor(authorA.userId))[0].moderationStatus, 'needs_human_review');
    assert.equal((await repository.adminQueue()).reviews.length, 1);
  });
});

test('periodic re-moderation scheduling is deduplicated for the same review revision and period', async () => {
  await withStore(async (storagePath) => {
    const repository = createReviewLabRepository(storagePath);
    await grantLanding(repository);
    const created = await repository.create(draft(), authorA); await approve(repository, created.id);
    const future = new Date('2035-05-12T00:00:00.000Z');
    assert.equal(await repository.enqueuePeriodicRechecks(future, 0), 1);
    assert.equal(await repository.enqueuePeriodicRechecks(future, 0), 0);
    const database = await repository.readDatabaseForTest();
    assert.equal(database.moderationJobs.filter((job) => job.reason === 'periodic:2035-05-12').length, 1);
  });
});

test('recurring scheduler patrols due published reviews, preserves safe content, and records one job per review', async () => {
  await withStore(async (storagePath) => {
    const moderationCalls = [];
    const moderator = {
      available: true,
      async moderate(review) {
        moderationCalls.push(review.id);
        return review.body.includes('管理者確認')
          ? { outcome: 'complete', decision: 'needs_human_review', reason: 'context requires human review', policyLabels: ['uncertain'], model: 'mock-nemotron' }
          : { outcome: 'complete', decision: 'approved', reason: 'safe first-person account', policyLabels: ['safe'], model: 'mock-nemotron' };
      },
    };
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, moderator });
    await grantLanding(api.repository, authorA, 'patrol-safe-node');
    await grantLanding(api.repository, authorB, 'patrol-review-node');
    const safe = await api.repository.create(draft({ sourceNodeId: 'patrol-safe-node', body: '実際に本を読み、静かな場面を何度も読み返した体験として記録します。次に読む人にも自分の速度で味わってほしいです。' }), authorA);
    const uncertain = await api.repository.create(draft({ sourceNodeId: 'patrol-review-node', body: '体験の文脈に管理者確認が必要な表現を含むため、定期パトロールの遷移を検証する隔離テスト文章です。' }), authorB);
    await approve(api.repository, safe.id);
    await approve(api.repository, uncertain.id);

    assert.equal(api.startJobs(300), true);
    const firstTickDeadline = Date.now() + 1_000;
    while (!api.schedulerStatus().lastTickCompletedAt && Date.now() < firstTickDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(api.schedulerStatus().lastTickCompletedAt);

    const stored = JSON.parse(await readFile(storagePath, 'utf8'));
    for (const review of stored.reviews) review.moderation.checkedAt = '2020-01-01T00:00:00.000Z';
    await writeFile(storagePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

    const patrolDeadline = Date.now() + 2_000;
    while (moderationCalls.length < 2 && Date.now() < patrolDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 350));
    api.stopJobs();

    assert.equal(moderationCalls.length, 2);
    assert.equal(new Set(moderationCalls).size, 2);
    assert.equal((await api.repository.listPublic(safe.subjectId, authorB.userId)).some((review) => review.id === safe.id), true);
    assert.equal((await api.repository.listPublic(uncertain.subjectId, authorA.userId)).some((review) => review.id === uncertain.id), false);
    const queue = await api.repository.adminQueue();
    assert.equal(queue.reviews.some((review) => review.id === uncertain.id && review.moderationStatus === 'needs_human_review'), true);
    assert.equal(queue.moderationJobs.filter((job) => job.reason.startsWith('periodic:')).length, 2);
    assert.ok(queue.moderationJobs.filter((job) => job.reason.startsWith('periodic:')).every((job) => job.status === 'complete' && job.attempts === 0));
    const auditLog = await api.repository.auditLog();
    assert.equal(auditLog.filter((entry) => entry.action === 'moderation.periodic_enqueued').length, 2);
    assert.ok(auditLog.some((entry) => entry.action === 'moderation.approved' && entry.targetId === safe.id));
    assert.ok(auditLog.some((entry) => entry.action === 'moderation.needs_human_review' && entry.targetId === uncertain.id));
    assert.ok(api.schedulerStatus().tickCount >= 3);
    assert.equal(api.schedulerStatus().running, false);
    assert.equal(api.schedulerStatus().lastError, null);
  });
});

test('reported public review can be hidden by admin, remains owner-readable, and admin endpoints reject users', async () => {
  await withStore(async (storagePath) => {
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, sessionSecret: 'test-secret', moderator: { available: false } });
    await grantLanding(api.repository);
    const created = await api.repository.create(draft(), authorA);
    await approve(api.repository, created.id);
    const report = await api.repository.report(created.id, authorB, { reason: 'other', details: '隔離E2Eで管理者確認へ送ります。' });
    const duplicate = await api.repository.report(created.id, authorB, { reason: 'other', details: '重複通報です。' });
    assert.equal(duplicate.id, report.id);
    assert.equal((await api.repository.adminQueue()).reports.length, 1);

    const userSession = await callMiddleware(api.middleware, { method: 'POST', url: '/session/dev', body: { userId: authorB.userId, role: 'user' } });
    const userCookie = String(userSession.headers['set-cookie']).split(';')[0];
    const forbiddenQueue = await callMiddleware(api.middleware, { method: 'GET', url: '/admin/queue', cookie: userCookie });
    const forbiddenStatus = await callMiddleware(api.middleware, { method: 'GET', url: '/admin/moderation/status', cookie: userCookie });
    assert.equal(forbiddenQueue.status, 403);
    assert.equal(forbiddenStatus.status, 403);

    await api.repository.adminReviewAction(created.id, admin, { action: 'hide', note: '隔離テストで非公開化' });
    await api.repository.resolveReport(report.id, admin, { resolution: '非公開化して確認完了' });
    assert.deepEqual(await api.repository.listPublic(created.subjectId, authorB.userId), []);
    assert.equal((await api.repository.listByAuthor(authorA.userId))[0].body, created.body);
    assert.equal((await api.repository.adminQueue()).reports.length, 0);
    await api.repository.freezeUser(authorA.userId, admin, { frozen: true, reason: '隔離テスト凍結' });
    await assert.rejects(api.repository.update(created.id, { body: '凍結後の編集を拒否するために十分な長さを持つ隔離テスト本文です。' }, authorA), (error) => error?.code === 'review_access_frozen');
    const actions = (await api.repository.auditLog()).map((entry) => entry.action);
    assert.ok(actions.includes('report.created'));
    assert.ok(actions.includes('admin.review.hide'));
    assert.ok(actions.includes('admin.report.resolved'));
    assert.ok(actions.includes('admin.user.frozen'));
  });
});

test('HTTP API uses signed session ownership and ignores a forged body authorId', async () => {
  await withStore(async (storagePath) => {
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, sessionSecret: 'test-secret' });
    await grantLanding(api.repository);
    const sessionA = await callMiddleware(api.middleware, { method: 'POST', url: '/session/dev', body: { userId: authorA.userId, role: 'user' } });
    assert.equal(sessionA.status, 200);
    const cookieA = String(sessionA.headers['set-cookie']).split(';')[0];
    const created = await callMiddleware(api.middleware, { method: 'POST', url: '/reviews', cookie: cookieA, body: { ...draft(), authorId: authorB.userId } });
    assert.equal(created.status, 201);
    const sessionB = await callMiddleware(api.middleware, { method: 'POST', url: '/session/dev', body: { userId: authorB.userId, role: 'user' } });
    const cookieB = String(sessionB.headers['set-cookie']).split(';')[0];
    const forbidden = await callMiddleware(api.middleware, { method: 'PUT', url: `/reviews/${created.body.review.id}`, cookie: cookieB, body: { body: 'ユーザーBがユーザーAの投稿を編集しようとする十分に長い本文です。' } });
    assert.equal(forbidden.status, 403); assert.equal(forbidden.body.error.code, 'author_mismatch');
    assert.equal((await api.repository.readDatabaseForTest()).reviews[0].authorId, authorA.userId);
  });
});

test('owner voyage-log API returns pending entries only to their signed author while public reads stay approved-only', async () => {
  await withStore(async (storagePath) => {
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, sessionSecret: 'test-secret' });
    await grantLanding(api.repository, authorA, 'author-a-node');
    await grantLanding(api.repository, authorB, 'author-b-node');
    const pendingA = await api.repository.create(draft({ sourceNodeId: 'author-a-node' }), authorA);
    const pendingB = await api.repository.create(draft({ sourceNodeId: 'author-b-node' }), authorB);
    const sessionA = await callMiddleware(api.middleware, { method: 'POST', url: '/session/dev', body: { userId: authorA.userId, role: 'user' } });
    const sessionB = await callMiddleware(api.middleware, { method: 'POST', url: '/session/dev', body: { userId: authorB.userId, role: 'user' } });
    const cookieA = String(sessionA.headers['set-cookie']).split(';')[0];
    const cookieB = String(sessionB.headers['set-cookie']).split(';')[0];

    const ownA = await callMiddleware(api.middleware, { method: 'GET', url: '/me/reviews', cookie: cookieA });
    const ownB = await callMiddleware(api.middleware, { method: 'GET', url: '/me/reviews', cookie: cookieB });
    assert.deepEqual(ownA.body.reviews.map((entry) => entry.id), [pendingA.id]);
    assert.deepEqual(ownB.body.reviews.map((entry) => entry.id), [pendingB.id]);
    assert.deepEqual(await api.repository.listPublic(pendingA.subjectId, authorB.userId), []);

    await approve(api.repository, pendingA.id);
    assert.deepEqual((await api.repository.listPublic(pendingA.subjectId, authorB.userId)).map((entry) => entry.id), [pendingA.id]);
    assert.equal((await api.repository.listByAuthor(authorB.userId))[0].moderationStatus, 'pending_moderation');
  });
});

test('direct review API rejects unlanded and forged subject or landed fields with 403', async () => {
  await withStore(async (storagePath) => {
    const api = createReviewLabApi({ storagePath, developmentAuthEnabled: true, sessionSecret: 'test-secret' });
    await api.repository.verifyNodeSubject(authorA.userId, 'unlanded-node', 'subject-action-read-galactic-railroad', admin);
    const session = await callMiddleware(api.middleware, { method: 'POST', url: '/session/dev', body: { userId: authorA.userId, role: 'user' } });
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const result = await callMiddleware(api.middleware, {
      method: 'POST', url: '/reviews', cookie,
      body: draft({ sourceNodeId: 'unlanded-node', landed: true, subjectId: 'subject-action-visit-ueno-park' }),
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'review_landing_required');
    assert.equal((await api.repository.readDatabaseForTest()).reviews.length, 0);
  });
});
