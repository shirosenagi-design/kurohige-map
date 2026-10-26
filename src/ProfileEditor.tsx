import { useState, type ChangeEvent } from 'react';
import { useProductState } from './ProductStateProvider';
import type { UserProfileState } from './productState';
import { t } from './i18n';
import { AuthPanel } from './AuthPanel';
import { AccountSyncPanel } from './AccountSyncPanel';
import type { WorldRepository } from './worldRepository';

const MAX_AVATAR_BYTES = 256 * 1024;
const values = (value: string) => [...new Set(value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean))];

export function ProfileEditor({ onClose, worldRepository }: { onClose: () => void; worldRepository: WorldRepository }) {
  const { state, dispatch } = useProductState();
  const [draft, setDraft] = useState<UserProfileState>(state.userProfile);
  const [practicalProfile, setPracticalProfile] = useState((state.userProfile.practicalProfile ?? []).join('\n'));
  const [avatarError, setAvatarError] = useState('');

  const setText = (field: keyof UserProfileState, value: string) => setDraft((current) => ({ ...current, [field]: value || undefined }));
  const setRegion = (field: 'countryCode' | 'administrativeArea', value: string) => setDraft((current) => ({
    ...current,
    region: { ...current.region, [field]: value || undefined },
  }));

  const chooseAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > MAX_AVATAR_BYTES) {
      setAvatarError(t('profile.avatarSizeError'));
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const avatarRef = reader.result;
      if (typeof avatarRef !== 'string') return;
      setDraft((current) => ({ ...current, avatarRef }));
      setAvatarError('');
    };
    reader.onerror = () => setAvatarError(t('profile.avatarReadError'));
    reader.readAsDataURL(file);
  };

  const save = () => {
    dispatch({
      type: 'UPDATE_PROFILE',
      profile: { ...draft, practicalProfile: values(practicalProfile) },
      confirmedAt: new Date().toISOString(),
    });
    onClose();
  };

  return <div className="profile-backdrop">
    <section className="profile-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <button className="profile-close" type="button" aria-label={t('profile.close')} onClick={onClose}>×</button>
      <header><p>{t('profile.eyebrow')}</p><h1 id="profile-title">{t('profile.title')}</h1><span>{t('profile.intro')}</span></header>

      <div className="profile-avatar-row">
        <div className="profile-avatar-preview">{draft.avatarRef ? <img src={draft.avatarRef} alt={t('profile.avatarAlt')} /> : <span>{draft.nickname?.slice(0, 1) || t('profile.avatarFallback')}</span>}</div>
        <label><span>{t('profile.icon')}</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={chooseAvatar} /></label>
        {draft.avatarRef && <button type="button" onClick={() => setDraft((current) => ({ ...current, avatarRef: undefined }))}>{t('profile.removeAvatar')}</button>}
      </div>
      {avatarError && <p className="profile-error" role="alert">{avatarError}</p>}

      <div className="profile-fields">
        <label><span>{t('profile.nickname')} <small>{t('common.required')}</small></span><input required value={draft.nickname ?? ''} onChange={(event) => setText('nickname', event.target.value)} maxLength={80} /></label>
        <label><span>{t('profile.birthDate')} <small>{t('common.optional')}</small></span><input type="date" value={draft.birthDate ?? ''} onChange={(event) => setText('birthDate', event.target.value)} /></label>
        <label><span>{t('profile.gender')} <small>{t('common.optional')}</small></span><input value={draft.selfIdentifiedGender ?? ''} onChange={(event) => setText('selfIdentifiedGender', event.target.value)} maxLength={80} /></label>
        <label><span>{t('profile.country')} <small>{t('common.required')}</small></span><input required list="country-code-options" value={draft.region?.countryCode ?? ''} onChange={(event) => setRegion('countryCode', event.target.value.toUpperCase())} minLength={2} maxLength={2} pattern="[A-Za-z]{2}" placeholder={t('profile.countryHint')} /></label>
        <datalist id="country-code-options"><option value="JP">{t('country.JP')}</option><option value="US">{t('country.US')}</option><option value="CA">{t('country.CA')}</option><option value="GB">{t('country.GB')}</option><option value="AU">{t('country.AU')}</option><option value="DE">{t('country.DE')}</option><option value="FR">{t('country.FR')}</option><option value="IN">{t('country.IN')}</option><option value="CN">{t('country.CN')}</option><option value="KR">{t('country.KR')}</option><option value="TW">{t('country.TW')}</option><option value="SG">{t('country.SG')}</option><option value="NZ">{t('country.NZ')}</option></datalist>
        <label><span>{t('profile.administrativeArea')} <small>{t('common.required')}</small></span><input required value={draft.region?.administrativeArea ?? ''} onChange={(event) => setRegion('administrativeArea', event.target.value)} maxLength={120} placeholder={t('profile.administrativeAreaPlaceholder')} /></label>
        <label><span>{t('profile.occupation')} <small>{t('common.optional')}</small></span><input value={draft.occupation ?? ''} onChange={(event) => setText('occupation', event.target.value)} maxLength={120} /></label>
        <label className="profile-wide"><span>{t('profile.practical')}</span><textarea value={practicalProfile} onChange={(event) => setPracticalProfile(event.target.value)} maxLength={1200} placeholder={t('common.linePlaceholder')} /></label>
      </div>

      <AuthPanel />
      <AccountSyncPanel worldRepository={worldRepository} />

      <footer><button type="button" onClick={onClose}>{t('profile.cancel')}</button><button type="button" className="profile-save" onClick={save}>{t('profile.save')}</button></footer>
    </section>
  </div>;
}
