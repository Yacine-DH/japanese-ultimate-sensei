export const DEFAULT_EXTENSION_FOLDER = '%USERPROFILE%\\Documents\\sensei-extension';
export const DEFAULT_EXTENSION_VERSION = '0.1.0';

export interface ServerVersionInfo {
  version?: string | null;
  commit: string;
  extension_commit: string | null;
  built_at: string | null;
}

export interface UpdateCheckResult {
  currentCommit: string;
  latestCommit: string;
  latestVersion?: string | null;
  builtAt: string | null;
  updateAvailable: boolean;
}

export function normalizeCommit(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

export function formatVersionTag(version: string | null | undefined): string {
  if (typeof version !== 'string') return '';
  const cleaned = version.trim().replace(/^v/i, '');
  return cleaned ? `v${cleaned}` : '';
}

export function getExtensionVersion(envOverride?: string): string {
  if (envOverride !== undefined) {
    const cleaned = envOverride.trim().replace(/^v/i, '');
    return cleaned || DEFAULT_EXTENSION_VERSION;
  }
  const g = globalThis as unknown as {
    browser?: { runtime?: { getManifest?: () => { version?: string } } };
    chrome?: { runtime?: { getManifest?: () => { version?: string } } };
  };
  const fromManifest =
    g.browser?.runtime?.getManifest?.()?.version ??
    g.chrome?.runtime?.getManifest?.()?.version;
  if (typeof fromManifest === 'string' && fromManifest.trim()) {
    return fromManifest.trim().replace(/^v/i, '');
  }
  const fromEnv =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.VITE_SENSEI_EXT_VERSION
      : undefined;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim().replace(/^v/i, '');
  }
  return DEFAULT_EXTENSION_VERSION;
}

export function getBuildCommit(envOverride?: string): string {
  const raw =
    envOverride !== undefined
      ? envOverride
      : typeof import.meta !== 'undefined' && import.meta.env
        ? import.meta.env.VITE_SENSEI_BUILD_COMMIT
        : undefined;
  const normalized = normalizeCommit(raw);
  return normalized || 'unknown';
}

const HEX_SHA_RE = /^[0-9a-f]{7,40}$/;

export function isSameCommit(current: string, latest: string): boolean {
  const a = normalizeCommit(current).toLowerCase();
  const b = normalizeCommit(latest).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (HEX_SHA_RE.test(a) && HEX_SHA_RE.test(b)) {
    return a.startsWith(b) || b.startsWith(a);
  }
  return false;
}

export function parseVersionInfo(raw: unknown): ServerVersionInfo | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return null;
  }
  const record = obj as Record<string, unknown>;
  const commit = normalizeCommit(record.commit);
  const extensionCommit = normalizeCommit(record.extension_commit);
  if (!commit && !extensionCommit) return null;
  const builtAtRaw = typeof record.built_at === 'string' ? record.built_at.trim() : '';
  const versionRaw = typeof record.version === 'string' ? record.version.trim() : '';
  return {
    ...(versionRaw ? { version: versionRaw } : {}),
    commit: commit || extensionCommit,
    extension_commit: extensionCommit || null,
    built_at: builtAtRaw || null,
  };
}

export function evaluateUpdateStatus(
  currentCommit: string,
  remote: ServerVersionInfo | null,
): UpdateCheckResult | null {
  if (!remote) return null;
  const current = normalizeCommit(currentCommit) || 'unknown';
  const latest = normalizeCommit(remote.extension_commit) || normalizeCommit(remote.commit);
  if (!latest) return null;
  const updateAvailable = current !== 'unknown' && !isSameCommit(current, latest);
  return {
    currentCommit: current,
    latestCommit: latest,
    ...(remote.version ? { latestVersion: remote.version } : {}),
    builtAt: remote.built_at,
    updateAvailable,
  };
}

/**
 * Normalizes a Windows folder path for PowerShell double-quoted strings:
 * expands `%ENVVAR%` placeholders to PowerShell's `$env:ENVVAR` syntax and escapes quotes.
 */
export function formatPowerShellFolderPath(folder?: string | null): string {
  const raw = typeof folder === 'string' && folder.trim() ? folder.trim() : DEFAULT_EXTENSION_FOLDER;
  const withPsEnv = raw.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => `$env:${name}`);
  return withPsEnv.replace(/"/g, '`"');
}

/**
 * Builds a self-contained PowerShell one-liner that downloads the latest extension zip from the
 * configured Sensei server and extracts it into the user's extension folder (#117).
 */
export function buildUpdateOneLiner(
  serverUrl: string,
  extensionFolder?: string | null,
  browserTarget: 'chrome' | 'firefox' = 'chrome',
): string {
  const cleanServer = serverUrl.trim().replace(/\/+$/, '') || 'http://homeserver:8000';
  const folder = formatPowerShellFolderPath(extensionFolder);
  const zipName =
    browserTarget === 'firefox' ? 'sensei-extension-firefox.zip' : 'sensei-extension-chrome.zip';
  return `$f="${folder}"; iwr ${cleanServer}/downloads/${zipName} -OutFile $env:TEMP\\s.zip; Expand-Archive $env:TEMP\\s.zip $f -Force`;
}

export function formatBuiltAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

export function formatUpdateHeadline(result: UpdateCheckResult): string {
  const built = formatBuiltAt(result.builtAt);
  if (built) {
    return `Update available (built ${built})`;
  }
  return `Update available (${result.latestCommit})`;
}

export function formatVersionLine(commit: string, version?: string): string {
  const normalized = normalizeCommit(commit) || 'unknown';
  const tag = formatVersionTag(version);
  if (tag) {
    return `Version: ${tag} (${normalized})`;
  }
  return `Version: ${normalized}`;
}

export function formatPopupFooterVersion(version: string, commit?: string): string {
  const tag = formatVersionTag(version) || formatVersionTag(DEFAULT_EXTENSION_VERSION);
  const normalized = normalizeCommit(commit);
  if (normalized && normalized !== 'unknown') {
    return `${tag} (${normalized})`;
  }
  return tag;
}

export function reloadExtension(): boolean {
  const g = globalThis as unknown as {
    browser?: { runtime?: { reload?: () => void } };
    chrome?: { runtime?: { reload?: () => void } };
  };
  const reload = g.browser?.runtime?.reload ?? g.chrome?.runtime?.reload;
  if (typeof reload !== 'function') {
    return false;
  }
  reload();
  return true;
}
