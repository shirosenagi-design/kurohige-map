export type ReviewSubjectKind = 'action_experience' | 'place' | 'book' | 'event' | 'community' | 'opportunity';

/**
 * Trusted resolver input for cross-user sharing. Exact canonical action identity
 * may be shared; island titles and mentioned places are never matching keys.
 */
export type ReviewActionIdentity = {
  canonicalExperienceKey: string;
  action: string;
  object?: string;
  setting?: string;
  qualifiers?: string[];
  purpose?: string;
  constraints?: string[];
};

export type ReviewExperienceResolution = {
  decision: 'same' | 'different' | 'uncertain';
  confidence: 'high' | 'medium' | 'low';
  matchedSubjectId: string | null;
  reason: string;
  comparedSubjectIds: string[];
  subjectId: string;
  method: 'ai' | 'ai_two_stage' | 'identity_exact' | 'cache' | 'paused' | 'error' | 'existing_history_link';
};

export type ReviewSubject = {
  id: string;
  kind: ReviewSubjectKind;
  name: string;
  referenceLabel: string;
  sharingScope?: 'shared_confirmed' | 'island_specific' | 'legacy_entity';
  identityVersion?: number;
  canonicalExperienceKey?: string | null;
};

export type ReviewModerationStatus = 'pending_moderation' | 'approved' | 'rejected' | 'needs_human_review';

export type ReviewAuthorSnapshot = {
  age: number | null;
  occupation: string | null;
  capturedAt?: string;
  shareAge?: boolean;
  shareOccupation?: boolean;
};

export type PublicReviewRecord = {
  id: string;
  subjectId: string;
  body: string;
  authorSnapshot: Pick<ReviewAuthorSnapshot, 'age' | 'occupation'>;
  createdAt: string;
  updatedAt: string;
  revision: number;
  helpfulCount: number;
  viewerHasHelpful: boolean;
};

export type OwnReviewRecord = PublicReviewRecord & {
  /** Personal island identity. It never becomes the shared subject identity. */
  sourceNodeId: string | null;
  moderationStatus: ReviewModerationStatus;
  authorSnapshot: ReviewAuthorSnapshot;
  moderation: { reason?: string; checkedAt?: string; method?: string } | null;
};

export type ReviewRecord = OwnReviewRecord;

export type ReviewBinding = {
  nodeId: string;
  subjectId: string;
};

export type ReviewViewer = {
  userId: string;
  role: 'user' | 'admin';
};

export type ReviewLabMapLink = {
  subjectId: string;
  sourceNodeId: string | null;
  mode: 'compose' | 'author-review';
};

export function reviewLabUrl(link?: ReviewLabMapLink) {
  const query = new URLSearchParams({ reviewLab: '1' });
  if (link) {
    query.set('subjectId', link.subjectId);
    query.set('mode', link.mode);
    if (link.sourceNodeId) query.set('sourceNodeId', link.sourceNodeId);
  }
  return `/?${query.toString()}`;
}
