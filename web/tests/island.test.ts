import { beforeEach, describe, expect, it } from 'vitest';
import type { AnimeOut } from '../src/api/client';
import {
  blossomCount,
  DEFAULT_ISLAND_SETTINGS,
  loadIslandSettings,
  MAX_BLOSSOMS,
  MAX_FLOORS,
  overallUnderstanding,
  pagodaFloors,
  routeFor,
  sanitizeIslandSettings,
  saveIslandSettings,
  senseiGreeting,
  timeOfDay,
} from '../src/lib/island';
import { emitIsland, onIsland } from '../src/scene/bus';

function anime(id: number, token_pct: number, episode_count = 1): AnimeOut {
  return {
    id,
    title: `アニメ${id}`,
    title_jp: null,
    anilist_id: null,
    episode_count,
    unique_words: 100,
    known_unique: 10,
    token_pct,
    unique_pct: token_pct,
  } as AnimeOut;
}

describe('routeFor', () => {
  it('gives every existing page a place on the island', () => {
    expect(routeFor('/').view).toBe('home');
    expect(routeFor('/library').view).toBe('library');
    expect(routeFor('/review').view).toBe('review');
    expect(routeFor('/kana').view).toBe('kana');
    expect(routeFor('/stats').view).toBe('progress');
    expect(routeFor('/words').layout).toBe('wide');
    expect(routeFor('/settings').layout).toBe('dock');
    expect(routeFor('/nope').layout).toBe('wide');
  });

  it('hides the scene only while watching', () => {
    expect(routeFor('/player').hidden).toBe(true);
    expect(routeFor('/episodes/12/watch').hidden).toBe(true);
    expect(routeFor('/episodes/12').hidden).toBe(false);
    expect(routeFor('/review/').hidden).toBe(false);
  });
});

describe('timeOfDay', () => {
  const at = (h: number, m = 0) => timeOfDay(new Date(2026, 10, 24, h, m));
  it('follows the clock', () => {
    expect(at(0)).toBe(1);
    expect(at(6, 30)).toBeCloseTo(0);
    expect(at(12)).toBeCloseTo(0.4);
    expect(at(18, 30)).toBeCloseTo(0.68);
    expect(at(23)).toBe(1);
  });
  it('stays inside 0..1 for every minute of the day', () => {
    for (let m = 0; m < 1440; m++) {
      const t = at(Math.floor(m / 60), m % 60);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });
});

describe('what the world shows', () => {
  it('stacks one pagoda floor per anime, best understood at the bottom', () => {
    const floors = pagodaFloors([anime(1, 20), anime(2, 60), anime(3, 40)]);
    expect(floors.map((f) => f.animeId)).toEqual([2, 3, 1]);
  });
  it('caps the pagoda and still builds one for an empty library', () => {
    expect(pagodaFloors(Array.from({ length: 9 }, (_, i) => anime(i, i)))).toHaveLength(MAX_FLOORS);
    expect(pagodaFloors([]).every((f) => f.animeId === null)).toBe(true);
    expect(pagodaFloors([])).toHaveLength(3);
  });
  it('grows one blossom per known word, within reason', () => {
    expect(blossomCount(486)).toBe(486);
    expect(blossomCount(0)).toBe(0);
    expect(blossomCount(-3)).toBe(0);
    expect(blossomCount(Number.NaN)).toBe(0);
    expect(blossomCount(99_999)).toBe(MAX_BLOSSOMS);
  });
  it('weights understanding by episode count', () => {
    expect(overallUnderstanding([])).toBeNull();
    expect(overallUnderstanding([anime(1, 80, 1), anime(2, 20, 3)])).toBeCloseTo(35);
  });
});

describe('senseiGreeting', () => {
  it('asks for a connection first, then for training, then for rest', () => {
    const base = { connected: true, due: 4, streak: 3, hour: 12 };
    expect(senseiGreeting({ ...base, connected: false }).en).toMatch(/connect/i);
    expect(senseiGreeting(base).en).toBe('You came again today. 4 cards are waiting.');
    expect(senseiGreeting({ ...base, due: 1 }).en).toContain('1 card is');
    expect(senseiGreeting({ ...base, streak: 0 }).en).toMatch(/^Let’s begin/);
    expect(senseiGreeting({ ...base, due: 0, hour: 23 }).en).toMatch(/rest/);
    expect(senseiGreeting({ ...base, due: 0 }).en).toMatch(/watch/);
  });
});

describe('island settings', () => {
  beforeEach(() => localStorage.clear());
  it('defaults, sanitizes and round-trips', () => {
    expect(loadIslandSettings()).toEqual(DEFAULT_ISLAND_SETTINGS);
    expect(sanitizeIslandSettings({ quality: 'ultra', time: 7 })).toEqual({
      quality: 'full',
      time: 1,
    });
    saveIslandSettings({ quality: 'light' });
    saveIslandSettings({ time: 0.5 });
    expect(loadIslandSettings()).toEqual({ quality: 'light', time: 0.5 });
    saveIslandSettings({ time: null });
    expect(loadIslandSettings().time).toBeNull();
  });
  it('survives corrupt storage', () => {
    localStorage.setItem('sensei_island', '{nope');
    expect(loadIslandSettings()).toEqual(DEFAULT_ISLAND_SETTINGS);
  });
});

describe('island bus', () => {
  it('delivers events until unsubscribed, and is silent without listeners', () => {
    const seen: string[] = [];
    const off = onIsland((e) => seen.push(e.type));
    emitIsland({ type: 'kana', ok: true });
    off();
    emitIsland({ type: 'reveal' });
    expect(seen).toEqual(['kana']);
  });
});
