/** Compare dotted numeric version strings (e.g. "0.1.44" vs "0.1.9"). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Pick the newest extension zip per browser (chrome / firefox) and optional server zip.
 * Keeps per-browser versions and computes the overall site version from SITE_VERSION or the newest zip.
 */
export function selectDownloads(files, envVersion = '') {
  const browsers = {};
  let serverZip = null;
  let serverVersion = null;

  for (const file of files) {
    if (!file.endsWith('.zip')) continue;
    const m = file.match(/^sensei-extension-(\d[\d.]*)-(chrome|firefox)\.zip$/);
    if (m) {
      const [, ver, browser] = m;
      if (!browsers[browser] || compareVersions(ver, browsers[browser].version) > 0) {
        browsers[browser] = { file, version: ver };
      }
      continue;
    }
    const sm = file.match(/^sensei-server(?:-v?(\d[\d.]*))?.*\.zip$/);
    if (sm) {
      const ver = sm[1] ?? null;
      if (
        !serverZip ||
        (ver && serverVersion && compareVersions(ver, serverVersion) > 0) ||
        (ver && !serverVersion) ||
        (!ver && !serverVersion && file > serverZip)
      ) {
        serverZip = file;
        serverVersion = ver;
      }
    }
  }

  let version = envVersion ? envVersion.replace(/^v/, '') : '';
  if (!version) {
    for (const entry of Object.values(browsers)) {
      if (!version || compareVersions(entry.version, version) > 0) version = entry.version;
    }
  }

  return { browsers, serverZip, version };
}
