import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const validRpId = (value) => typeof value === 'string' && value.length > 0 && !value.includes('://') && !value.includes('/');

export function createPasskeyService({ rpName = 'KUROHIGE MAP', rpID = '', expectedOrigin = '' } = {}) {
  let origin;
  try { origin = new URL(expectedOrigin); } catch { origin = null; }
  const available = validRpId(rpID) && origin && origin.origin === expectedOrigin
    && (origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)));
  if (available && origin.hostname !== rpID && !origin.hostname.endsWith(`.${rpID}`)) {
    throw new Error('WEBAUTHN_RP_ID must be the origin host or a registrable parent domain.');
  }

  return {
    available: Boolean(available), rpID, expectedOrigin, rpName,
    async registrationOptions({ accountId, userId, userName, credentials = [] }) {
      if (!available) throw new Error('Passkey authentication is not configured.');
      return generateRegistrationOptions({
        rpName, rpID,
        userID: Buffer.from(userId, 'base64url'),
        userName,
        userDisplayName: userName,
        attestationType: 'none',
        excludeCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        supportedAlgorithmIDs: [-7, -257],
      });
    },
    async authenticationOptions() {
      if (!available) throw new Error('Passkey authentication is not configured.');
      return generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
    },
    verifyRegistration({ response, challengeHashMatches }) {
      return verifyRegistrationResponse({
        response,
        expectedChallenge: challengeHashMatches,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    },
    verifyAuthentication({ response, credential, challengeHashMatches }) {
      return verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeHashMatches,
        expectedOrigin,
        expectedRPID: rpID,
        credential,
        requireUserVerification: true,
      });
    },
  };
}

export function clientDataChallenge(response) {
  try {
    const encoded = response?.response?.clientDataJSON;
    if (typeof encoded !== 'string' || encoded.length > 8192) return '';
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof value.challenge === 'string' && value.challenge.length <= 512 ? value.challenge : '';
  } catch { return ''; }
}
