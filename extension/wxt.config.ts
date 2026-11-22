import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

// Public RSA-2048 DER key (base64) for a stable Chromium/Edge unpacked extension ID.
// Private key was discarded at generation time; unpacked loading only uses the public key.
export const CHROME_MANIFEST_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyEOJ3cqCFFjVOzwsG+aO5r5/8ZI7D7LSWhTminlA76VPmLoIRILwcCdZ0DHX7VVz+eDTn3XWjM5WaJDtM/VS89J2afyxkwN1MHI7FjMRQ+l0Li/UfMsV5WjnRNM8+ZlIvRiAJ6tUpZhGbeWAgBpq/akqpVSYsWQcSWzvrF/mg6A6PphqSKwuwfAvoZK1X3zbsVLCcyaEcEmA4qB8VMM9iup0PjMh/Xf1wliuvJjIkTEH7DrUpekOqNLdPANpTiIbkVhIc/zrSAp8lX1IlM0cqiMaXTGHU+vS2JoRj+TrGFdPeQtCs03xxzykCk0t+9KTNgwaNqi5nLwOrxjBzK4nYwIDAQAB';

export const FIREFOX_GECKO_ID = 'sensei@japanese-ultimate-sensei.local';

export const DEFAULT_EXTENSION_VERSION = '0.1.0';

const MANIFEST_VERSION_RE = /^\d+(?:\.\d+){0,3}$/;

export function resolveExtensionVersion(
  raw: string | undefined = process.env.SENSEI_EXT_VERSION,
): string {
  const cleaned = raw?.trim().replace(/^v/i, '') ?? '';
  if (!cleaned || !MANIFEST_VERSION_RE.test(cleaned)) {
    return DEFAULT_EXTENSION_VERSION;
  }
  return cleaned;
}

export const EXTENSION_ICONS = {
  16: 'icon/16.png',
  32: 'icon/32.png',
  48: 'icon/48.png',
  128: 'icon/128.png',
} as const;

export function resolveBuildCommit(cwd: string = EXTENSION_DIR): string {
  const fromEnv = process.env.SENSEI_BUILD_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const extCommit = execSync('git log -1 --format=%h --abbrev=7 -- .', {
      cwd,
      encoding: 'utf8',
    }).trim();
    if (extCommit) return extCommit;
  } catch {
    // Fall through to repo HEAD fallback
  }
  try {
    return execSync('git rev-parse --short=7 HEAD', { cwd, encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const BUILD_COMMIT = resolveBuildCommit();

export default defineConfig({
  vite: () => ({
    define: {
      'import.meta.env.VITE_SENSEI_BUILD_COMMIT': JSON.stringify(BUILD_COMMIT),
      'import.meta.env.VITE_SENSEI_EXT_VERSION': JSON.stringify(resolveExtensionVersion()),
    },
  }),
  manifest: ({ browser, manifestVersion }) => ({
    name: 'Japanese Ultimate Sensei',
    description:
      'Turn every anime episode into a Japanese lesson with interactive furigana subtitles and hover dictionary.',
    version: resolveExtensionVersion(),
    icons: EXTENSION_ICONS,
    ...(manifestVersion === 2
      ? {
          browser_action: {
            default_icon: EXTENSION_ICONS,
          },
        }
      : {
          action: {
            default_icon: EXTENSION_ICONS,
          },
        }),
    permissions:
      browser === 'firefox'
        ? ['storage', 'activeTab', 'tabs']
        : ['storage', 'activeTab', 'tabs', 'nativeMessaging'],
    host_permissions: ['<all_urls>'],
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: FIREFOX_GECKO_ID,
            },
          },
        }
      : {
          key: CHROME_MANIFEST_PUBLIC_KEY,
        }),
  }),
});
