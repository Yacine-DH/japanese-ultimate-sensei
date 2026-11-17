import { api } from '../../src/api/client';
import { getSettings, saveSettings } from '../../src/lib/settings';

const healthBadge = document.getElementById('health-badge') as HTMLSpanElement;
const serverUrlText = document.getElementById('server-url-text') as HTMLSpanElement;
const versionText = document.getElementById('version-text') as HTMLSpanElement;
const dictText = document.getElementById('dict-text') as HTMLSpanElement;
const authText = document.getElementById('auth-text') as HTMLSpanElement;
const episodeSelect = document.getElementById('episode-select') as HTMLSelectElement;
const openOptionsBtn = document.getElementById('open-options-btn') as HTMLButtonElement;

async function refreshPopup(): Promise<void> {
  const settings = await getSettings();
  serverUrlText.textContent = settings.serverUrl.replace(/^https?:\/\//, '');

  const healthRes = await api.getHealth();
  if (healthRes.ok && healthRes.data) {
    const h = healthRes.data;
    healthBadge.textContent = h.status === 'ok' ? 'Online' : h.status;
    healthBadge.className = 'badge online';
    versionText.textContent = h.version;
    dictText.textContent = h.dictionary ? 'Ready' : 'Not built';
    authText.textContent = h.auth ? 'Required' : 'Open';
  } else {
    healthBadge.textContent = 'Offline';
    healthBadge.className = 'badge offline';
    versionText.textContent = healthRes.error ?? 'Unreachable';
    dictText.textContent = '-';
    authText.textContent = '-';
    return;
  }

  const episodesRes = await api.listEpisodes();
  if (episodesRes.ok && episodesRes.data) {
    episodeSelect.innerHTML = '<option value="">None (overlay disabled)</option>';
    for (const ep of episodesRes.data) {
      const opt = document.createElement('option');
      opt.value = String(ep.id);
      const anime = ep.anime_title ?? 'Anime';
      const num = ep.number !== null ? ` Ep ${ep.number}` : '';
      opt.textContent = `${anime}${num} (${ep.line_count} lines)`;
      if (settings.activeEpisodeId === ep.id) {
        opt.selected = true;
      }
      episodeSelect.appendChild(opt);
    }
  }
}

episodeSelect.addEventListener('change', async () => {
  const val = episodeSelect.value;
  await saveSettings({
    activeEpisodeId: val ? Number(val) : null,
  });
});

openOptionsBtn.addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

void refreshPopup();
