import type { AnimeOut } from '../api/client';

/** Pure logic behind the Sensei Island scene: what the world shows, where the camera goes, when. */

export type IslandView = 'home' | 'library' | 'review' | 'kana' | 'progress' | 'away';
export type PageLayout = 'home' | 'dock' | 'wide';
export type SceneQuality = 'full' | 'light' | 'off';

export interface IslandRoute {
  view: IslandView;
  layout: PageLayout;
  /** Short name for styling hooks (`data-page`). */
  page: string;
  /** The 3D scene is fully hidden here (e.g. while watching a video). */
  hidden: boolean;
}

export function routeFor(pathname: string): IslandRoute {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { view: 'home', layout: 'home', page: 'home', hidden: false };
  if (path === '/player' || /^\/episodes\/[^/]+\/watch$/.test(path)) {
    return { view: 'away', layout: 'wide', page: 'player', hidden: true };
  }
  if (path.startsWith('/episodes/')) {
    return { view: 'library', layout: 'wide', page: 'episode', hidden: false };
  }
  if (path === '/library')
    return { view: 'library', layout: 'dock', page: 'library', hidden: false };
  if (path === '/review') return { view: 'review', layout: 'dock', page: 'review', hidden: false };
  if (path === '/kana') return { view: 'kana', layout: 'dock', page: 'kana', hidden: false };
  if (path === '/stats') return { view: 'progress', layout: 'dock', page: 'stats', hidden: false };
  if (path === '/words') return { view: 'progress', layout: 'wide', page: 'words', hidden: false };
  if (path === '/settings')
    return { view: 'away', layout: 'dock', page: 'settings', hidden: false };
  return { view: 'away', layout: 'wide', page: 'other', hidden: false };
}

/** 0 = dawn, 0.4 = midday, 0.68 = sunset, 1 = night. */
export function timeOfDay(date: Date): number {
  const h = date.getHours() + date.getMinutes() / 60;
  const stops: Array<[number, number]> = [
    [0, 1],
    [4.5, 1],
    [6.5, 0],
    [12, 0.4],
    [16, 0.42],
    [18.5, 0.68],
    [21, 1],
    [24, 1],
  ];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (h <= b[0]) {
      const k = (h - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * k;
    }
  }
  return 1;
}

export interface PagodaFloor {
  animeId: number | null;
  title: string;
  pct: number;
}

export const MAX_FLOORS = 5;

/** One pagoda storey per anime, best understood at the bottom (the widest, most solid floor). */
export function pagodaFloors(anime: readonly AnimeOut[]): PagodaFloor[] {
  const floors: PagodaFloor[] = [...anime]
    .sort((a, b) => b.token_pct - a.token_pct || a.id - b.id)
    .slice(0, MAX_FLOORS)
    .map((a) => ({ animeId: a.id, title: a.title, pct: a.token_pct }));
  // An empty library still gets a small pagoda to build on.
  while (floors.length < 3) floors.push({ animeId: null, title: '', pct: 0 });
  return floors;
}

export const MAX_BLOSSOMS = 1500;

/** One blossom per known word, capped so the tree never costs more than it should. */
export function blossomCount(knownWords: number): number {
  if (!Number.isFinite(knownWords) || knownWords <= 0) return 0;
  return Math.min(MAX_BLOSSOMS, Math.floor(knownWords));
}

/** Dialogue understood over the whole library, weighted by how many episodes each anime has. */
export function overallUnderstanding(anime: readonly AnimeOut[]): number | null {
  let weight = 0;
  let sum = 0;
  for (const a of anime) {
    const w = Math.max(1, a.episode_count);
    weight += w;
    sum += a.token_pct * w;
  }
  return weight === 0 ? null : sum / weight;
}

export interface SenseiLine {
  /** [text, reading?] pairs. */
  jp: ReadonlyArray<readonly [string, string?]>;
  en: string;
}

/** What the old sensei says on the home page. */
export function senseiGreeting(input: {
  connected: boolean;
  due: number;
  streak: number;
  hour: number;
}): SenseiLine {
  const { connected, due, streak, hour } = input;
  if (!connected) {
    return {
      jp: [['まずは'], ['道', 'みち'], ['を'], ['開', 'ひら'], ['こう。']],
      en: 'Let’s open the path first: connect the app to your Sensei server.',
    };
  }
  if (due > 0 && streak === 0) {
    return {
      jp: [['さあ、'], ['始', 'はじ'], ['めよう。']],
      en: `Let’s begin. ${due} card${due === 1 ? ' is' : 's are'} waiting.`,
    };
  }
  if (due > 0) {
    return {
      jp: [['今日', 'きょう'], ['も'], ['来', 'き'], ['たか。えらいぞ。']],
      en: `You came again today. ${due} card${due === 1 ? ' is' : 's are'} waiting.`,
    };
  }
  if (hour >= 21 || hour < 5) {
    return {
      jp: [['よくやった。もう'], ['休', 'やす'], ['め。']],
      en: 'Well done. Nothing is due, so get some rest.',
    };
  }
  return {
    jp: [['よくやった。'], ['何', 'なに'], ['か'], ['見', 'み'], ['よう。']],
    en: 'Well done, nothing is due. Let’s watch something.',
  };
}

export interface IslandSettings {
  quality: SceneQuality;
  /** Fixed time of day (0..1), or null to follow the clock. */
  time: number | null;
}

export const ISLAND_STORAGE_KEY = 'sensei_island';
export const DEFAULT_ISLAND_SETTINGS: IslandSettings = { quality: 'full', time: null };

export function sanitizeIslandSettings(raw: unknown): IslandSettings {
  const o = (raw ?? {}) as Partial<IslandSettings>;
  const quality: SceneQuality = o.quality === 'light' || o.quality === 'off' ? o.quality : 'full';
  const time =
    typeof o.time === 'number' && Number.isFinite(o.time) ? Math.min(1, Math.max(0, o.time)) : null;
  return { quality, time };
}

export function loadIslandSettings(): IslandSettings {
  try {
    const raw = globalThis.localStorage?.getItem(ISLAND_STORAGE_KEY);
    if (raw) return sanitizeIslandSettings(JSON.parse(raw));
    // Phones and tablets start with the light scene until someone chooses otherwise.
    const touch = globalThis.matchMedia?.('(pointer: coarse)').matches === true;
    return { ...DEFAULT_ISLAND_SETTINGS, quality: touch ? 'light' : 'full' };
  } catch {
    return { ...DEFAULT_ISLAND_SETTINGS };
  }
}

export function saveIslandSettings(patch: Partial<IslandSettings>): IslandSettings {
  const next = sanitizeIslandSettings({ ...loadIslandSettings(), ...patch });
  try {
    globalThis.localStorage?.setItem(ISLAND_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors in restricted environments
  }
  return next;
}
