import { canonicalBridgeTags } from './semanticBridgeVocabulary.ts';
import { emptyPersonState, type CompletedExperience, type PersonState } from './livingFlow.ts';
import type { ProductLocale } from './i18n.ts';

export const PRODUCT_STATE_SCHEMA_VERSION = 2 as const;
export const PRODUCT_STATE_STORAGE_KEY = 'kurohige-map.product-state.v2';
export const LEGACY_PRODUCT_STATE_STORAGE_KEY = 'kurohige-map.product-state.v1';

export type ProductSection = 'summary' | 'map' | 'list';
export type PersonContextField = 'interests' | 'engagementPatterns' | 'constraints' | 'recentChanges';

export type UserProfileState = {
  nickname?: string;
  avatarRef?: string;
  birthDate?: string;
  selfIdentifiedGender?: string;
  region?: {
    countryCode?: string;
    administrativeArea?: string;
  };
  occupation?: string;
  practicalProfile?: string[];
  updatedAt: string;
};

export type ObservedPersonSignal = {
  id: string;
  proposedDomain: string;
  evidenceNodeIds: string[];
  sourceActions: string[];
  status: 'pending' | 'confirmed' | 'dismissed';
  observedAt: string;
};

export type PersistedProductState = {
  version: typeof PRODUCT_STATE_SCHEMA_VERSION;
  personState: PersonState;
  userProfile: UserProfileState;
  onboardingComplete: boolean;
  personContextRevision: number;
  observedPersonSignals: ObservedPersonSignal[];
};

export type ProductState = PersistedProductState & {
  section: ProductSection;
};

export type WorldGenerationCommand =
  | { type: 'INITIAL_WORLD_GENERATION_REQUESTED'; personContextRevision: number; locale: ProductLocale }
  | { type: 'FRONTIER_EXPANSION_REQUESTED'; explorationBand: number; locale: ProductLocale }
  | { type: 'PERSON_CONTEXT_EXPANSION_REQUESTED'; personContextRevision: number; locale: ProductLocale };

export type ProductStateAction =
  | { type: 'SET_SECTION'; section: ProductSection }
  | { type: 'CONFIRM_PERSON_CONTEXT'; context: Pick<PersonState, PersonContextField> }
  | { type: 'UPDATE_PROFILE'; profile: UserProfileState; confirmedAt: string }
  | { type: 'REPLACE_PERSON_STATE'; personState: PersonState }
  | { type: 'ADD_OBSERVED_SIGNAL'; signal: ObservedPersonSignal }
  | { type: 'CONFIRM_OBSERVED_SIGNAL'; id: string; contextField?: PersonContextField; confirmedValue?: string }
  | { type: 'DISMISS_OBSERVED_SIGNAL'; id: string };

export interface ProductStateRepository {
  load(): PersistedProductState;
  save(state: PersistedProductState): void;
  clear(): void;
}

export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const cleanOptionalText = (value: unknown) => cleanText(value) || undefined;
const cleanCountryCode = (value: unknown) => {
  const countryCode = cleanText(value).toUpperCase();
  return /^[A-Z]{2}$/u.test(countryCode) ? countryCode : undefined;
};
const cleanStringArray = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.map(cleanText).filter(Boolean))]
  : [];

const sameStringArray = (left: readonly string[], right: readonly string[]) => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

const cleanExperience = (value: unknown): CompletedExperience | null => {
  if (!isRecord(value)) return null;
  const stepId = cleanText(value.stepId);
  const nodeId = cleanText(value.nodeId);
  const title = cleanText(value.title);
  const experienceTag = cleanText(value.experienceTag);
  if (!stepId || !nodeId || !title || !experienceTag) return null;
  return {
    stepId,
    nodeId,
    title,
    experienceTag,
    gainedResources: cleanStringArray(value.gainedResources),
    bridgeTags: canonicalBridgeTags(cleanStringArray(value.bridgeTags)),
  };
};

export function normalizePersonState(value: unknown): PersonState {
  if (!isRecord(value)) return emptyPersonState();
  const experiences = Array.isArray(value.experiences)
    ? value.experiences.map(cleanExperience).filter((entry): entry is CompletedExperience => entry !== null)
    : [];
  return {
    interests: cleanStringArray(value.interests),
    engagementPatterns: cleanStringArray(value.engagementPatterns),
    constraints: cleanStringArray(value.constraints),
    recentChanges: cleanStringArray(value.recentChanges),
    portableResources: cleanStringArray(value.portableResources),
    experiences,
    completedSteps: cleanStringArray(value.completedSteps),
    bridgeTags: canonicalBridgeTags(cleanStringArray(value.bridgeTags)),
  };
}

export function normalizeUserProfile(value: unknown): UserProfileState {
  if (!isRecord(value)) return { updatedAt: '' };
  const region = isRecord(value.region) ? {
    countryCode: cleanCountryCode(value.region.countryCode ?? value.region.country),
    administrativeArea: cleanOptionalText(value.region.administrativeArea ?? value.region.prefecture),
  } : undefined;
  const cleanRegion = region?.countryCode || region?.administrativeArea ? region : undefined;
  return {
    nickname: cleanOptionalText(value.nickname),
    avatarRef: cleanOptionalText(value.avatarRef),
    birthDate: cleanOptionalText(value.birthDate),
    selfIdentifiedGender: cleanOptionalText(value.selfIdentifiedGender),
    region: cleanRegion,
    occupation: cleanOptionalText(value.occupation),
    practicalProfile: cleanStringArray(value.practicalProfile),
    updatedAt: cleanText(value.updatedAt),
  };
}

export type RequiredProfileField = 'nickname' | 'countryCode' | 'administrativeArea';

export function missingRequiredProfileFields(profile: UserProfileState): RequiredProfileField[] {
  const normalized = normalizeUserProfile(profile);
  const missing: RequiredProfileField[] = [];
  if (!normalized.nickname) missing.push('nickname');
  if (!normalized.region?.countryCode) missing.push('countryCode');
  if (!normalized.region?.administrativeArea) missing.push('administrativeArea');
  return missing;
}

export const isOnboardingProfileComplete = (profile: UserProfileState) => missingRequiredProfileFields(profile).length === 0;

const normalizeSignal = (value: unknown): ObservedPersonSignal | null => {
  if (!isRecord(value)) return null;
  const id = cleanText(value.id);
  const proposedDomain = cleanText(value.proposedDomain);
  const observedAt = cleanText(value.observedAt);
  const status = value.status;
  if (!id || !proposedDomain || !observedAt || (status !== 'pending' && status !== 'confirmed' && status !== 'dismissed')) return null;
  return {
    id,
    proposedDomain,
    evidenceNodeIds: cleanStringArray(value.evidenceNodeIds),
    sourceActions: cleanStringArray(value.sourceActions),
    status,
    observedAt,
  };
};

export const createEmptyPersistedProductState = (): PersistedProductState => ({
  version: PRODUCT_STATE_SCHEMA_VERSION,
  personState: emptyPersonState(),
  userProfile: normalizeUserProfile({ updatedAt: '' }),
  onboardingComplete: false,
  personContextRevision: 0,
  observedPersonSignals: [],
});

export const createInitialProductState = (persisted = createEmptyPersistedProductState()): ProductState => ({
  ...persisted,
  onboardingComplete: persisted.onboardingComplete && isOnboardingProfileComplete(persisted.userProfile),
  section: persisted.onboardingComplete && isOnboardingProfileComplete(persisted.userProfile) ? 'map' : 'summary',
});

export function parsePersistedProductState(raw: string | null): PersistedProductState {
  if (!raw) return createEmptyPersistedProductState();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || (value.version !== 1 && value.version !== PRODUCT_STATE_SCHEMA_VERSION)
      || typeof value.onboardingComplete !== 'boolean'
      || typeof value.personContextRevision !== 'number' || !Number.isSafeInteger(value.personContextRevision)
      || value.personContextRevision < 0 || !Array.isArray(value.observedPersonSignals)
      || !isRecord(value.personState) || !isRecord(value.userProfile)) {
      return createEmptyPersistedProductState();
    }
    return {
      version: PRODUCT_STATE_SCHEMA_VERSION,
      personState: normalizePersonState(value.personState),
      userProfile: normalizeUserProfile(value.userProfile),
      onboardingComplete: value.onboardingComplete && isOnboardingProfileComplete(normalizeUserProfile(value.userProfile)),
      personContextRevision: value.personContextRevision,
      observedPersonSignals: value.observedPersonSignals.map(normalizeSignal).filter((signal): signal is ObservedPersonSignal => signal !== null),
    };
  } catch {
    return createEmptyPersistedProductState();
  }
}

export const persistedSnapshot = (state: ProductState): PersistedProductState => ({
  version: PRODUCT_STATE_SCHEMA_VERSION,
  personState: state.personState,
  userProfile: state.userProfile,
  onboardingComplete: state.onboardingComplete,
  personContextRevision: state.personContextRevision,
  observedPersonSignals: state.observedPersonSignals,
});

export function createLocalStorageProductStateRepository(storage: BrowserStorage): ProductStateRepository {
  return {
    load: () => {
      try {
        return parsePersistedProductState(storage.getItem(PRODUCT_STATE_STORAGE_KEY) ?? storage.getItem(LEGACY_PRODUCT_STATE_STORAGE_KEY));
      } catch {
        return createEmptyPersistedProductState();
      }
    },
    save: (state) => {
      storage.setItem(PRODUCT_STATE_STORAGE_KEY, JSON.stringify(state));
      storage.removeItem(LEGACY_PRODUCT_STATE_STORAGE_KEY);
    },
    clear: () => {
      storage.removeItem(PRODUCT_STATE_STORAGE_KEY);
      storage.removeItem(LEGACY_PRODUCT_STATE_STORAGE_KEY);
    },
  };
}

const sameContext = (personState: PersonState, context: Pick<PersonState, PersonContextField>) => (
  sameStringArray(personState.interests, context.interests)
  && sameStringArray(personState.engagementPatterns, context.engagementPatterns)
  && sameStringArray(personState.constraints, context.constraints)
  && sameStringArray(personState.recentChanges, context.recentChanges)
);

const generationProfile = (profile: UserProfileState) => JSON.stringify({
  birthDate: profile.birthDate ?? '',
  selfIdentifiedGender: profile.selfIdentifiedGender ?? '',
  region: profile.region ?? {},
  occupation: profile.occupation ?? '',
  practicalProfile: profile.practicalProfile ?? [],
});

export function productStateReducer(state: ProductState, action: ProductStateAction): ProductState {
  if (action.type === 'SET_SECTION') return state.section === action.section ? state : { ...state, section: action.section };
  if (action.type === 'REPLACE_PERSON_STATE') return { ...state, personState: normalizePersonState(action.personState) };
  if (action.type === 'CONFIRM_PERSON_CONTEXT') {
    const context = {
      interests: cleanStringArray(action.context.interests),
      engagementPatterns: cleanStringArray(action.context.engagementPatterns),
      constraints: cleanStringArray(action.context.constraints),
      recentChanges: cleanStringArray(action.context.recentChanges),
    };
    const changed = !sameContext(state.personState, context);
    return {
      ...state,
      onboardingComplete: isOnboardingProfileComplete(state.userProfile),
      personContextRevision: state.personContextRevision + (changed ? 1 : 0),
      personState: changed ? { ...state.personState, ...context } : state.personState,
    };
  }
  if (action.type === 'UPDATE_PROFILE') {
    const profile = normalizeUserProfile({ ...action.profile, updatedAt: action.confirmedAt });
    const currentComparable = JSON.stringify({ ...state.userProfile, updatedAt: '' });
    const nextComparable = JSON.stringify({ ...profile, updatedAt: '' });
    if (currentComparable === nextComparable) return state;
    const generationRelevantChange = generationProfile(state.userProfile) !== generationProfile(profile);
    const profileComplete = isOnboardingProfileComplete(profile);
    return {
      ...state,
      userProfile: profile,
      onboardingComplete: state.onboardingComplete && profileComplete,
      section: state.onboardingComplete && !profileComplete ? 'summary' : state.section,
      personContextRevision: state.personContextRevision + (generationRelevantChange ? 1 : 0),
    };
  }
  if (action.type === 'ADD_OBSERVED_SIGNAL') {
    if (state.observedPersonSignals.some((signal) => signal.id === action.signal.id)) return state;
    return { ...state, observedPersonSignals: [...state.observedPersonSignals, action.signal] };
  }
  if (action.type === 'CONFIRM_OBSERVED_SIGNAL') {
    const signal = state.observedPersonSignals.find((candidate) => candidate.id === action.id);
    if (!signal || signal.status !== 'pending') return state;
    const value = cleanText(action.confirmedValue);
    const field = action.contextField;
    const personState = field && value
      ? { ...state.personState, [field]: [...new Set([...state.personState[field], value])] }
      : state.personState;
    return {
      ...state,
      personState,
      personContextRevision: state.personContextRevision + (personState === state.personState ? 0 : 1),
      observedPersonSignals: state.observedPersonSignals.map((candidate) => candidate.id === action.id
        ? { ...candidate, status: 'confirmed' }
        : candidate),
    };
  }
  if (action.type === 'DISMISS_OBSERVED_SIGNAL') {
    const signal = state.observedPersonSignals.find((candidate) => candidate.id === action.id);
    if (!signal || signal.status !== 'pending') return state;
    return {
      ...state,
      observedPersonSignals: state.observedPersonSignals.map((candidate) => candidate.id === action.id
        ? { ...candidate, status: 'dismissed' }
        : candidate),
    };
  }
  return state;
}
