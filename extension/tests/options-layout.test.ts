import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('options page layout and manifest metadata (#54)', () => {
  const optionsHtml = readFileSync(
    resolve(__dirname, '../entrypoints/options/index.html'),
    'utf-8',
  );
  const popupMain = readFileSync(
    resolve(__dirname, '../entrypoints/popup/main.ts'),
    'utf-8',
  );

  it('configures WXT to open options in a full browser tab', () => {
    expect(optionsHtml).toContain('<meta name="manifest.open_in_tab" content="true" />');
    expect(popupMain).toContain('browser.runtime.openOptionsPage()');
  });

  it('uses a single-column default layout with wrapping controls for narrow dialogs (<= 400px)', () => {
    expect(optionsHtml).toContain('flex-direction: column;');
    expect(optionsHtml).toContain('min-width: 0;');
    expect(optionsHtml).toContain('flex-wrap: wrap;');
    expect(optionsHtml).toContain('@media (max-width: 420px)');
  });
});
