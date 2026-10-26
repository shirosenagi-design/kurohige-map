import { isOnboardingProfileComplete, type UserProfileState } from './productState.ts';

export type CoverWorldAvailability = {
  status: 'hydrating' | 'ready' | 'missing' | 'corrupt';
  hasWorld: boolean;
};

export type CoverDestination = 'pending' | 'summary' | 'map';

export function resolveCoverDestination({
  onboardingComplete,
  profile,
  world,
}: {
  onboardingComplete: boolean;
  profile: UserProfileState;
  world: CoverWorldAvailability;
}): CoverDestination {
  if (world.status === 'hydrating') return 'pending';
  if (!onboardingComplete || !isOnboardingProfileComplete(profile)) return 'summary';
  if (world.status === 'ready' && world.hasWorld) return 'map';
  return 'summary';
}
