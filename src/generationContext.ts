import type { PersonState } from './livingFlow.ts';
import type { ProductLocale } from './i18n.ts';
import { isOnboardingProfileComplete, type UserProfileState } from './productState.ts';

export type ProductGenerationContext = {
  mode: 'person_map';
  personState: PersonState;
  userProfile: {
    birthDate?: string;
    selfIdentifiedGender?: string;
    region?: { countryCode?: string; administrativeArea?: string };
    occupation?: string;
    practicalProfile: string[];
  };
  locale: ProductLocale;
  contextSeed: string | null;
};

export function createProductGenerationContext(
  personState: PersonState,
  profile: UserProfileState,
  locale: ProductLocale,
  contextSeed: string | null = null,
): ProductGenerationContext {
  return {
    mode: 'person_map',
    personState,
    userProfile: {
      birthDate: profile.birthDate,
      selfIdentifiedGender: profile.selfIdentifiedGender,
      region: profile.region,
      occupation: profile.occupation,
      practicalProfile: profile.practicalProfile ?? [],
    },
    locale,
    contextSeed: contextSeed?.trim() || null,
  };
}

export function canStartInitialWorldGeneration({ status, nodeCount, onboardingComplete, profile }: {
  status: 'hydrating' | 'ready' | 'missing' | 'corrupt';
  nodeCount: number;
  onboardingComplete: boolean;
  profile: UserProfileState;
}) {
  return status === 'missing' && nodeCount === 0 && onboardingComplete && isOnboardingProfileComplete(profile);
}
