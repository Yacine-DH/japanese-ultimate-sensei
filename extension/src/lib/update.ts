export const UPDATE_POWERSHELL_COMMAND =
  'powershell -ExecutionPolicy Bypass -File update-extension.ps1';

export interface ServerVersionInfo {
  commit: string;
  built_at: string | null;
}

export interface UpdateCheckResult {
  currentCommit: string;
  latestCommit: string;
  builtAt: string | null;
  updateAvailable: boolean;
}

export function normalizeCommit(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
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
  if (!commit) return null;
  const builtAtRaw = typeof record.built_at === 'string' ? record.built_at.trim() : '';
  return {
    commit,
    built_at: builtAtRaw || null,
  };
}

export function evaluateUpdateStatus(
  currentCommit: string,
  remote: ServerVersionInfo | null,
): UpdateCheckResult | null {
  if (!remote) return null;
  const current = normalizeCommit(currentCommit) || 'unknown';
  const latest = normalizeCommit(remote.commit);
  if (!latest) return null;
  const updateAvailable = current !== 'unknown' && !isSameCommit(current, latest);
  return {
    currentCommit: current,
    latestCommit: latest,
    builtAt: remote.built_at,
    updateAvailable,
  };
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

export function formatVersionLine(commit: string): string {
  const normalized = normalizeCommit(commit) || 'unknown';
  return `Version: ${normalized}`;
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
