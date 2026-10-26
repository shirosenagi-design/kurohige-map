import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useCallback, useEffect, useState } from 'react';
import { t } from './i18n';

type SessionView = { id: string; authMethod: string; issuedAt: string; lastSeenAt: string; revokedAt: string | null };
type PasskeyView = { id: string; displayName: string; deviceType: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type AuthStatus = {
  session: SessionView;
  account: { accountType: 'anonymous' | 'registered'; email: string | null; emailVerifiedAt: string | null; passkeyCount: number };
  passkeyAvailable: boolean;
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/reviews${path}`, {
    ...init, credentials: 'same-origin',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || t('auth.error'));
  return payload as T;
}

export function AuthPanel() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [passkeys, setPasskeys] = useState<PasskeyView[]>([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [devMagicUrl, setDevMagicUrl] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      await api('/session', { method: 'POST' });
      const next = await api<AuthStatus>('/auth/status');
      setStatus(next);
      const [sessionList, passkeyList] = await Promise.all([
        api<{ sessions: SessionView[] }>('/sessions'),
        next.account.accountType === 'registered' ? api<{ passkeys: PasskeyView[] }>('/auth/passkeys') : Promise.resolve({ passkeys: [] }),
      ]);
      setSessions(sessionList.sessions); setPasskeys(passkeyList.passkeys);
      window.dispatchEvent(new CustomEvent('kurohige-auth-changed', { detail: { accountType: next.account.accountType } }));
    } catch (reason) {
      setStatus(null); setError(reason instanceof Error ? reason.message : t('auth.error'));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (name: string, operation: () => Promise<void>) => {
    setBusy(name); setError(''); setNotice('');
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : t('auth.error')); }
    finally { setBusy(''); }
  };

  const sendEmail = () => run('email', async () => {
    await api('/auth/email/start', { method: 'POST', body: JSON.stringify({ email }) });
    setNotice(t('auth.emailSent')); setDevMagicUrl('');
    try {
      const dev = await api<{ delivery: { magicUrl?: string } | null }>('/auth/dev/mailbox/latest');
      if (dev.delivery?.magicUrl) setDevMagicUrl(dev.delivery.magicUrl);
    } catch { /* endpoint exists only in an explicitly isolated development setup */ }
  });

  const registerPasskey = () => run('register', async () => {
    const start = await api<{ options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/auth/passkeys/register/options', { method: 'POST' });
    const response = await startRegistration({ optionsJSON: start.options });
    await api('/auth/passkeys/register/verify', { method: 'POST', body: JSON.stringify({ response, displayName: t('auth.passkeyDefaultName') }) });
    setNotice(t('auth.passkeyRegistered')); await refresh();
  });

  const loginPasskey = () => run('login', async () => {
    const start = await api<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/auth/passkeys/authenticate/options', { method: 'POST' });
    const response = await startAuthentication({ optionsJSON: start.options });
    await api('/auth/passkeys/authenticate/verify', { method: 'POST', body: JSON.stringify({ response }) });
    setNotice(t('auth.loggedIn')); await refresh();
  });

  const revokePasskey = (id: string) => run(`passkey:${id}`, async () => {
    await api(`/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refresh();
  });
  const revokeSession = (id: string) => run(`session:${id}`, async () => {
    await api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refresh();
  });
  const logout = () => run('logout', async () => {
    await api('/session', { method: 'DELETE' }); await refresh(); setNotice(t('auth.loggedOut'));
  });

  const registered = status?.account.accountType === 'registered';
  const passkeyUsable = status?.passkeyAvailable && browserSupportsWebAuthn();

  return <section className="auth-panel" aria-labelledby="auth-panel-title">
    <header><p>{t('auth.eyebrow')}</p><h2 id="auth-panel-title">{t('auth.title')}</h2><span>{t('auth.intro')}</span></header>
    {!status && !error && <p>{t('auth.loading')}</p>}
    {status && <>
      <div className="auth-state">
        <strong>{registered ? t('auth.registered') : t('auth.anonymous')}</strong>
        <span>{status.account.email ?? t('auth.emailUnverified')}</span>
      </div>
      {!registered && <div className="auth-email">
        <label><span>{t('auth.email')}</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button type="button" disabled={busy !== '' || !email.trim()} onClick={() => void sendEmail()}>{t('auth.sendMagicLink')}</button>
      </div>}
      {devMagicUrl && <a className="auth-dev-link" href={devMagicUrl}>{t('auth.devMagicLink')}</a>}
      <div className="auth-actions">
        {registered && <button type="button" disabled={busy !== '' || !passkeyUsable} onClick={() => void registerPasskey()}>{t('auth.registerPasskey')}</button>}
        <button type="button" disabled={busy !== '' || !passkeyUsable} onClick={() => void loginPasskey()}>{t('auth.loginPasskey')}</button>
        <button type="button" disabled={busy !== ''} onClick={() => void refresh()}>{t('auth.refresh')}</button>
        <button type="button" disabled={busy !== ''} onClick={() => void logout()}>{t('auth.logout')}</button>
      </div>
      {!passkeyUsable && <p className="auth-hint">{t('auth.passkeyUnavailable')}</p>}
      {registered && <div className="auth-management">
        <h3>{t('auth.passkeys')}</h3>
        {passkeys.length === 0 ? <p>{t('auth.noPasskeys')}</p> : passkeys.map((item) => <article key={item.id}>
          <div><strong>{item.displayName}</strong><small>{item.backedUp ? t('auth.syncedPasskey') : item.deviceType}</small></div>
          <button type="button" disabled={busy !== '' || Boolean(item.revokedAt)} onClick={() => void revokePasskey(item.id)}>{item.revokedAt ? t('auth.revoked') : t('auth.revoke')}</button>
        </article>)}
        <h3>{t('auth.sessions')}</h3>
        {sessions.map((item) => <article key={item.id}>
          <div><strong>{item.id === status.session.id ? t('auth.currentSession') : t('auth.otherSession')}</strong><small>{item.authMethod}</small></div>
          <button type="button" disabled={busy !== '' || item.id === status.session.id || Boolean(item.revokedAt)} onClick={() => void revokeSession(item.id)}>{item.revokedAt ? t('auth.revoked') : t('auth.revoke')}</button>
        </article>)}
      </div>}
    </>}
    {notice && <p className="auth-notice" role="status">{notice}</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
  </section>;
}
