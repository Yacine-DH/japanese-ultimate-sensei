import { execSync } from 'node:child_process';
import { defineConfig } from 'wxt';

// Public RSA-2048 DER key (base64) for a stable Chromium/Edge unpacked extension ID.
// Private key was discarded at generation time; unpacked loading only uses the public key.
export const CHROME_MANIFEST_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyEOJ3cqCFFjVOzwsG+aO5r5/8ZI7D7LSWhTminlA76VPmLoIRILwcCdZ0DHX7VVz+eDTn3XWjM5WaJDtM/VS89J2afyxkwN1MHI7FjMRQ+l0Li/UfMsV5WjnRNM8+ZlIvRiAJ6tUpZhGbeWAgBpq/akqpVSYsWQcSWzvrF/mg6A6PphqSKwuwfAvoZK1X3zbsVLCcyaEcEmA4qB8VMM9iup0PjMh/Xf1wliuvJjIkTEH7DrUpekOqNLdPANpTiIbkVhIc/zrSAp8lX1IlM0cqiMaXTGHU+vS2JoRj+TrGFdPeQtCs03xxzykCk0t+9KTNgwaNqi5nLwOrxjBzK4nYwIDAQAB';

export const FIREFOX_GECKO_ID = 'sensei@japanese-ultimate-sensei.local';

function resolveBuildCommit(): string {
  const fromEnv = process.env.SENSEI_BUILD_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const BUILD_COMMIT = resolveBuildCommit();

export default defineConfig({
  vite: () => ({
    define: {
      'import.meta.env.VITE_SENSEI_BUILD_COMMIT': JSON.stringify(BUILD_COMMIT),
    },
  }),
  manifest: ({ browser }) => ({
    name: 'Japanese Ultimate Sensei',
    description:
      'Turn every anime episode into a Japanese lesson with interactive furigana subtitles and hover dictionary.',
    version: '0.1.0',
    permissions: ['storage', 'activeTab', 'tabs'],
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
