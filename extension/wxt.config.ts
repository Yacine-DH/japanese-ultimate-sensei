import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Japanese Ultimate Sensei',
    description: 'Turn every anime episode into a Japanese lesson with interactive furigana subtitles and hover dictionary.',
    version: '0.1.0',
    permissions: ['storage', 'activeTab', 'tabs'],
    host_permissions: ['<all_urls>'],
  },
});
