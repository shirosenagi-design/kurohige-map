import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { PossibilityNode, PossibilityNodeState } from '../src/livingFlow.ts';
import type { OwnReviewRecord, ReviewModerationStatus } from '../src/reviewLabContract.ts';
import { buildVoyageLogEntries, voyageLogModerationLabel, voyageLogTitle } from '../src/voyageLog.ts';

const node = (id: string, title: string) => ({ id, title } as PossibilityNode);
const state = (landed: boolean) => ({ landed } as PossibilityNodeState);
const review = (id: string, sourceNodeId: string, moderationStatus: ReviewModerationStatus, updatedAt: string): OwnReviewRecord => ({
  id,
  subjectId: `subject-${sourceNodeId}`,
  sourceNodeId,
  body: `${sourceNodeId}で実際に体験した航海日誌の本文です。`,
  moderationStatus,
  authorSnapshot: { age: null, occupation: null },
  moderation: null,
  createdAt: updatedAt,
  updatedAt,
  revision: 1,
  helpfulCount: 0,
  viewerHasHelpful: false,
});

test('voyage log contains every landed island, keeps unwritten pages, and excludes unlanded islands', () => {
  const nodes = [node('landed-written', '記入済みの島'), node('landed-empty', '未記入の島'), node('unlanded', '未上陸の島')];
  const states = {
    'landed-written': state(true),
    'landed-empty': state(true),
    unlanded: state(false),
  };
  const entries = buildVoyageLogEntries(nodes, states, [
    review('older', 'landed-written', 'approved', '2026-10-01T00:00:00.000Z'),
    review('newer', 'landed-written', 'pending_moderation', '2026-10-02T00:00:00.000Z'),
    review('foreign', 'unlanded', 'approved', '2026-10-03T00:00:00.000Z'),
  ]);

  assert.deepEqual(entries.map((entry) => entry.node.id), ['landed-written', 'landed-empty']);
  assert.deepEqual(entries[0].reviews.map((entry) => entry.id), ['newer', 'older']);
  assert.equal(entries[1].reviews.length, 0);
});

test('voyage log title uses the saved nickname and has the canonical fallback', () => {
  assert.equal(voyageLogTitle('航海テスト'), '航海テストの航海日誌');
  assert.equal(voyageLogTitle('   '), 'あなたの航海日誌');
});

test('all moderation states have owner-readable Japanese labels', () => {
  assert.deepEqual({
    pending_moderation: voyageLogModerationLabel('pending_moderation'),
    approved: voyageLogModerationLabel('approved'),
    rejected: voyageLogModerationLabel('rejected'),
    needs_human_review: voyageLogModerationLabel('needs_human_review'),
  }, {
    pending_moderation: '審査中',
    approved: '公開済み',
    rejected: '非公開',
    needs_human_review: '人間による確認待ち',
  });
});

test('Product UI connects voyage-log pages to the existing island Peek without changing map mechanics', async () => {
  const [livingFlow, reviewSection] = await Promise.all([
    readFile(new URL('../src/LivingFlowPilot.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/ReviewSection.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(livingFlow, /<VoyageLogList/u);
  assert.match(livingFlow, /reopenNodeFromList\(nodeId, true\)/u);
  assert.match(livingFlow, /setDetailNodeId\(nodeId\)/u);
  assert.match(reviewSection, /review\.publicTitle/u);
  assert.match(reviewSection, /review\.write/u);
  assert.match(reviewSection, /review\.edit/u);
  assert.match(reviewSection, /requestGeneration/u);
  assert.match(reviewSection, /data-review-loading/u);
  assert.match(reviewSection, /visibleContext\?\.subject/u);
  assert.doesNotMatch(reviewSection, /setContext\(next\); await refreshReviews/u);
});
