import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, buildAuthHeaders, SenseiApiError } from '../src/api/client';
import {
  loadWebSettings,
  normalizeServerUrl,
  saveWebSettings,
} from '../src/lib/settings';

describe('web settings and API client (W-1)', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it('persists and loads web settings from localStorage', () => {
    expect(normalizeServerUrl('http://sensei.local:8000///')).toBe('http://sensei.local:8000');

    const saved = saveWebSettings({
      serverUrl: 'http://100.64.0.2:8000/',
      apiToken: ' web-secret ',
      glossLang: 'ger',
      romaji: true,
    });

    expect(saved).toEqual({
      serverUrl: 'http://100.64.0.2:8000',
      apiToken: 'web-secret',
      glossLang: 'ger',
      romaji: true,
    });
    expect(loadWebSettings()).toEqual(saved);
  });

  it('attaches bearer and X-Sensei-Token headers and parses JSON', async () => {
    const headers = buildAuthHeaders({ apiToken: 'tok_abc' });
    expect(headers['Authorization']).toBe('Bearer tok_abc');
    expect(headers['X-Sensei-Token']).toBe('tok_abc');

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'ok', version: '0.1.0', dictionary: true, auth: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const res = await apiRequest<{ status: string }>('/health', {
      settings: { serverUrl: 'http://sensei:8000', apiToken: 'tok_abc' },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(res.status).toBe('ok');
  });

  it('throws SenseiApiError with server detail on non-2xx responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Episode not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      apiRequest('/episodes/999', {
        settings: { serverUrl: 'http://sensei:8000', apiToken: '' },
        fetchImpl: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrowError(new SenseiApiError(404, 'Episode not found'));
  });
});
