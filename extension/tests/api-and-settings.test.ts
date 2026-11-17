import { describe, expect, it, vi } from 'vitest';
import { buildApiHeaders, executeApiCall, isApiCallMessage } from '../src/api/client';
import {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  sanitizeSettings,
} from '../src/lib/settings';

describe('settings utilities', () => {
  it('normalizes server URLs and falls back to default', () => {
    expect(normalizeServerUrl('  http://sensei.tailnet:8000/// ')).toBe(
      'http://sensei.tailnet:8000',
    );
    expect(normalizeServerUrl('   ')).toBe(DEFAULT_SERVER_URL);
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
      romaji: true,
      highlightLimit: 20,
      urlMappings: { 'site.to/watch/frieren-ep-1': 7 },
    });
  });
});

describe('API background proxy', () => {
  it('identifies valid API call messages', () => {
    expect(isApiCallMessage({ type: 'SENSEI_API_CALL', path: '/health' })).toBe(true);
    expect(isApiCallMessage({ type: 'OTHER' })).toBe(false);
    expect(isApiCallMessage(null)).toBe(false);
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
});
