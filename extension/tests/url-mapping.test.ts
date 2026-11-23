import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EpisodeOut } from '../src/api/client';
import {
  buildMissedUrl,
  buildPrepUrl,
  buildPrimingUrl,
  buildSettingsUrl,
  extractUrlEpisodeInfo,
  filterEpisodes,
  normalizePageUrlPattern,
  resolveEpisodeForUrl,
} from '../src/lib/url-mapping';

function makeEpisode(overrides: Partial<EpisodeOut> = {}): EpisodeOut {
  return {
    id: 1,
    anime_id: 10,
    anime_title: 'Sousou no Frieren',
    number: 1,
    title: 'The Journey Begins',
    source: 'upload',
    source_filename: 'frieren_01.ass',
    sub_offset_ms: 0,
    sync_points: [],
    line_count: 320,
    created_at: '2026-11-17T00:00:00Z',
    ...overrides,
  };
}

describe('page URL → episode mapping and E-4 picker logic (#2, #20)', () => {
  it('normalizes streaming page URLs and ignores non-http schemes', () => {
    expect(
      normalizePageUrlPattern('https://Site.TO/watch/frieren-ep-3/?utm_source=x#t=10'),
    ).toBe('site.to/watch/frieren-ep-3');
    expect(
      normalizePageUrlPattern('https://anime.example/watch?v=frieren&ep=4&ref=home'),
    ).toBe('anime.example/watch?ep=4&v=frieren');
    expect(normalizePageUrlPattern('chrome://extensions')).toBeNull();
  });

  it('extracts episode numbers from path and query patterns', () => {
    expect(extractUrlEpisodeInfo('site.to/watch/frieren-ep-3')).toEqual({
      prefixPattern: 'site.to/watch/frieren-ep-*',
      episodeNumber: 3,
    });
    expect(extractUrlEpisodeInfo('site.to/watch?ep=12&v=abc')).toEqual({
      prefixPattern: 'site.to/watch?ep=*&v=abc',
      episodeNumber: 12,
    });
  });

  it('matches exact URL mappings and suggests the next episode when URL increments', () => {
    const episodes: EpisodeOut[] = [
      makeEpisode({ id: 101, anime_id: 10, anime_title: 'Frieren', number: 3 }),
      makeEpisode({ id: 102, anime_id: 10, anime_title: 'Frieren', number: 4 }),
      makeEpisode({ id: 201, anime_id: 20, anime_title: 'Solo Leveling', number: 4 }),
    ];
    const mappings = {
      'site.to/watch/frieren-ep-3': 101,
    };

    // Exact match on ep 3
    const exact = resolveEpisodeForUrl(
      'https://site.to/watch/frieren-ep-3',
      mappings,
      episodes,
    );
    expect(exact.matchedEpisodeId).toBe(101);
    expect(exact.suggestedEpisode).toBeNull();

    // Unrelated tab/site has neither match nor suggestion
    const youtube = resolveEpisodeForUrl(
      'https://www.youtube.com/watch?v=12345',
      mappings,
      episodes,
    );
    expect(youtube.matchedEpisodeId).toBeNull();
    expect(youtube.suggestedEpisode).toBeNull();

    // Incrementing to ep 4 automatically suggests Frieren ep 4 (id 102)
    const nextEp = resolveEpisodeForUrl(
      'https://site.to/watch/frieren-ep-4',
      mappings,
      episodes,
    );
    expect(nextEp.matchedEpisodeId).toBeNull();
    expect(nextEp.suggestedEpisode?.id).toBe(102);
  });

  it('filters episodes by anime title, episode number, or filename', () => {
    const episodes: EpisodeOut[] = [
      makeEpisode({ id: 1, anime_title: 'Frieren', number: 1 }),
      makeEpisode({ id: 2, anime_title: 'Frieren', number: 2 }),
      makeEpisode({ id: 3, anime_title: 'Dungeon Meshi', number: 1 }),
    ];
    expect(filterEpisodes(episodes, 'dungeon').map((e) => e.id)).toEqual([3]);
    expect(filterEpisodes(episodes, 'ep 2').map((e) => e.id)).toEqual([2]);
  });

  it('builds the web prep, priming, and missed URLs and wires popup Prep button (#35, #134)', () => {
    expect(buildPrimingUrl('http://homeserver:8000/', 42)).toBe(
      'http://homeserver:8000/episodes/42?prime=1',
    );
    expect(buildPrimingUrl('', 42)).toBeNull();

    expect(buildPrepUrl('http://homeserver:8000/', 42)).toBe(
      'http://homeserver:8000/episodes/42?prep=1',
    );
    expect(buildPrepUrl('', 42)).toBeNull();

    expect(buildMissedUrl('http://homeserver:8000/', 42)).toBe(
      'http://homeserver:8000/episodes/42?missed=1',
    );

    expect(buildSettingsUrl('http://homeserver:8000/')).toBe(
      'http://homeserver:8000/settings',
    );
    expect(buildSettingsUrl('')).toBeNull();

    const popupHtml = readFileSync(resolve(__dirname, '../entrypoints/popup/index.html'), 'utf-8');
    const popupMain = readFileSync(resolve(__dirname, '../entrypoints/popup/main.ts'), 'utf-8');
    expect(popupHtml).toContain('Prep this episode: 10 words');
    expect(popupMain).toContain('buildPrepUrl');
  });
});
