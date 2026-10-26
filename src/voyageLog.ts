import { t } from './i18n.ts';
import type { PossibilityNode, PossibilityNodeState } from './livingFlow.ts';
import type { OwnReviewRecord, ReviewModerationStatus } from './reviewLabContract.ts';

export type VoyageLogEntry = {
  node: PossibilityNode;
  reviews: OwnReviewRecord[];
};

export const voyageLogOwnerName = (nickname?: string) => nickname?.trim() || t('list.voyageLogFallbackName');

export const voyageLogTitle = (nickname?: string) => nickname?.trim()
  ? t('list.voyageLogTitle', { name: nickname.trim() })
  : t('list.voyageLogFallbackTitle');

export const voyageLogModerationLabel = (status: ReviewModerationStatus) => ({
  pending_moderation: t('review.status.pending'),
  approved: t('review.status.approved'),
  rejected: t('review.status.rejected'),
  needs_human_review: t('review.status.humanReview'),
})[status];

export function buildVoyageLogEntries(
  nodes: readonly PossibilityNode[],
  nodeStates: Readonly<Record<string, PossibilityNodeState>>,
  ownReviews: readonly OwnReviewRecord[],
): VoyageLogEntry[] {
  return nodes
    .filter((node) => nodeStates[node.id]?.landed === true)
    .map((node) => ({
      node,
      reviews: ownReviews
        .filter((review) => review.sourceNodeId === node.id)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    }));
}
