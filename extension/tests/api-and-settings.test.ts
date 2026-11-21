import { describe, expect, it, vi } from 'vitest';
import {
  api,
  buildApiHeaders,
  executeApiCall,
  isApiCallMessage,
  verifyServerConnection,
} from '../src/api/client';
import { DEFAULT_HOTKEYS } from '../src/lib/hotkeys';
import {
  DEFAULT_SERVER_URL,
  isServerUrlConfigured,
  normalizeServerUrl,
  sanitizeSettings,
} from '../src/lib/settings';

describe('settings utilities', () => {
  it('normalizes server URLs and treats empty or placeholder URLs as unconfigured (#7)', () => {
    expect(DEFAULT_SERVER_URL).toBe('');
    expect(normalizeServerUrl('  http://sensei.tailnet:8000/// ')).toBe(
      'http://sensei.tailnet:8000',
    );
    expect(normalizeServerUrl('   ')).toBe('');
    expect(normalizeServerUrl('http://<tailscale-host>:8000')).toBe('');
    expect(isServerUrlConfigured('')).toBe(false);
    expect(isServerUrlConfigured('http://<tailscale-host>:8000')).toBe(false);
    expect(isServerUrlConfigured('http://homeserver:8000')).toBe(true);
  });

  it('sanitizes settings with safe defaults, bounds, and URL mappings', () => {
    const s = sanitizeSettings({
      serverUrl: 'http://100.64.0.1:8000/',
      apiToken: ' secret-token ',
      glossLang: 'ger',
      romaji: true,
      highlightLimit: 99,
      urlMappings: { 'site.to/watch/frieren-ep-1': 7 },
    });
    expect(s).toEqual({
      serverUrl: 'http://100.64.0.1:8000',
      apiToken: 'secret-token',
      glossLang: 'ger',
      translationMode: 'off',
      romaji: true,
      highlightLimit: 20,
      hoverDelayMs: 200,
      pauseOnHover: true,
      requireShiftForHover: false,
      autoPauseEachLine: false,
      ankiConnectEnabled: false,
      ankiConnectUrl: 'http://localhost:8765',
      ankiDeckName: 'Sensei',
      ankiModelName: 'Sensei Japanese',
      urlMappings: { 'site.to/watch/frieren-ep-1': 7 },
      hotkeys: DEFAULT_HOTKEYS,
    });
  });
});

describe('API background proxy', () => {
  it('identifies valid API call messages', () => {
    expect(isApiCallMessage({ type: 'SENSEI_API_CALL', path: '/health' })).toBe(true);
    expect(isApiCallMessage({ type: 'OTHER' })).toBe(false);
    expect(isApiCallMessage(null)).toBe(false);
  });

  it('returns clear error when server URL is unconfigured without calling fetch (#7)', async () => {
    const mockFetch = vi.fn();
    const res = await executeApiCall(
      { serverUrl: '', apiToken: '' },
      '/health',
      undefined,
      mockFetch as unknown as typeof fetch,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not configured/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns clear error instead of falling back to direct fetch when background runtime is unavailable (#7)', async () => {
    const res = await api.call('/health');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toMatch(/background worker unavailable/i);
  });

  it('builds auth headers when token is present', () => {
    const withToken = buildApiHeaders(
      { apiToken: 'tok_123' },
      { method: 'POST', json: { status: 'known' } },
    );
    expect(withToken['Authorization']).toBe('Bearer tok_123');
    expect(withToken['X-Sensei-Token']).toBe('tok_123');
    expect(withToken['Content-Type']).toBe('application/json');

    const withoutToken = buildApiHeaders({ apiToken: '' });
    expect(withoutToken['Authorization']).toBeUndefined();
    expect(withoutToken['X-Sensei-Token']).toBeUndefined();
  });

  it('executes GET and POST calls with token and parses JSON responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'ok', version: '0.1.0', dictionary: true, auth: true }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const res = await executeApiCall(
      { serverUrl: 'http://sensei:8000/', apiToken: 'my-token' },
      '/health',
      undefined,
      mockFetch as unknown as typeof fetch,
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      status: 'ok',
      version: '0.1.0',
      dictionary: true,
      auth: true,
    });
  });

  it('extracts FastAPI error details on non-2xx responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Invalid or missing API token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await executeApiCall(
      { serverUrl: 'http://sensei:8000', apiToken: 'wrong' },
      '/episodes',
      undefined,
      mockFetch as unknown as typeof fetch,
    );

    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error).toBe('Invalid or missing API token');
  });

  it('distinguishes 401 wrong/missing token from server unreachable (#7, #11)', async () => {
    const unauthorized = await verifyServerConnection(
      {
        getHealth: async () => ({
          ok: true,
          status: 200,
          data: {
            status: 'ok',
            version: '0.1.0',
            dictionary: true,
            auth: true,
            ffmpeg: true,
            media_bytes: 0,
          },
        }),
        listEpisodes: async () => ({ ok: false, status: 401, error: 'Unauthorized' }),
      },
      'http://homeserver:8000',
    );
    expect(unauthorized.state).toBe('unauthorized');

    const unreachable = await verifyServerConnection(
      {
        getHealth: async () => ({ ok: false, status: 0, error: 'Failed to fetch' }),
        listEpisodes: async () => ({ ok: false, status: 0, error: 'Failed to fetch' }),
      },
      'http://homeserver:8000',
    );
    expect(unreachable.state).toBe('unreachable');
  });
});
