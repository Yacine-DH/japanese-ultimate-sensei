import { describe, expect, it } from 'vitest';
import type { LineOut, TokenOut } from '../src/api/client';
import {
  applyPlayerOffsetToActiveStretch,
  computePlayerSeekSeconds,
  computeSyncOffsetMs,
  findActivePlayerLines,
  findPlayerLineToReplay,
  findReferenceLineForSync,
  formatOffsetLabel,
  isSupportedVideoFile,
  normalizePlayerSyncPoints,
  PlayerWatchAccumulator,
  rankPlayerHighlightIndices,
  resolvePlayerOffsetAt,
  resolvePlayerOffsetForLine,
  shouldAutoPauseAfterLine,
} from '../src/lib/player';

function makeToken(overrides: Partial<TokenOut> = {}): TokenOut {
  return {
    surface: '魔法',
    lemma: '魔法',
    reading: 'まほう',
    lemma_reading: 'まほう',
    pos: '名詞',
    pos_detail: ['一般'],
    furigana: [{ text: '魔法', ruby: 'まほう' }],
    romaji: 'mahou',
    is_content: true,
    is_proper_noun: false,
    word_id: 1,
    status: 'new',
    common: true,
    zipf: 4.5,
    ...overrides,
  };
}

function makeLine(id: number, startMs: number, endMs: number, text = 'テスト'): LineOut {
  return {
    id,
    idx: id - 1,
    start_ms: startMs,
    end_ms: endMs,
    text,
    romaji: 'tesuto',
    tokens: [],
    translation_en: null,
    translation_de: null,
  };
}

describe('web built-in player helpers (W-6 / #32)', () => {
  it('validates supported local video files by mime or extension', () => {
    expect(isSupportedVideoFile({ name: 'frieren_01.mp4', type: 'video/mp4' })).toBe(true);
    expect(isSupportedVideoFile({ name: 'frieren_01.mkv', type: '' })).toBe(true);
    expect(isSupportedVideoFile({ name: 'subs.srt', type: 'text/plain' })).toBe(false);
  });

  it('finds overlapping active lines respecting subOffsetMs', () => {
    const lines = [
      makeLine(1, 1_000, 4_000, 'Line 1'),
      makeLine(2, 3_000, 6_000, 'Line 2'),
      makeLine(3, 8_000, 10_000, 'Line 3'),
    ];
    expect(findActivePlayerLines(lines, 3_500, 0).map((l) => l.id)).toEqual([1, 2]);
    // With +500 ms offset, Line 1 shows at 1500..4500, Line 2 at 3500..6500
    expect(findActivePlayerLines(lines, 3_400, 500).map((l) => l.id)).toEqual([1]);
    expect(findActivePlayerLines(lines, 3_600, 500).map((l) => l.id)).toEqual([1, 2]);
    expect(findActivePlayerLines(lines, 7_000, 0)).toEqual([]);
  });

  it('ranks unknown content tokens by Zipf desc with common tie-break', () => {
    const tokens: TokenOut[] = [
      makeToken({ word_id: 1, lemma: '希少', common: true, zipf: 2.0 }),
      makeToken({ word_id: 2, lemma: '旅', common: false, zipf: 5.1 }),
      makeToken({ word_id: 3, lemma: '食べる', common: true, zipf: 5.9 }),
      makeToken({ word_id: 4, lemma: '既知', status: 'known', zipf: 6.5 }),
      makeToken({ word_id: 5, lemma: 'フリーレン', is_proper_noun: true, zipf: 6.0 }),
    ];
    expect(Array.from(rankPlayerHighlightIndices(tokens, 2)).sort()).toEqual([1, 2]);
  });

  it('computes replay targets, sync offsets, and auto-pause transitions', () => {
    const lines = [makeLine(1, 2_000, 4_000), makeLine(2, 6_000, 9_000)];
    // Between line 1 and line 2 -> replays line 1
    expect(findPlayerLineToReplay(lines, 5_000, 0)?.id).toBe(1);
    expect(computePlayerSeekSeconds(lines[0]!, 500)).toBe(2.5);
    expect(findReferenceLineForSync(lines, 5_500, 0)?.id).toBe(2);
    expect(computeSyncOffsetMs(6_450, lines[1]!)).toBe(450);
    expect(formatOffsetLabel(200)).toBe('+200 ms');
    expect(formatOffsetLabel(-100)).toBe('-100 ms');

    expect(shouldAutoPauseAfterLine([1], [], true)).toBe(true);
    expect(shouldAutoPauseAfterLine([1], [1], true)).toBe(false);
    expect(shouldAutoPauseAfterLine([1], [], false)).toBe(false);
  });

  it('accumulates watch-time heartbeats every 30 s and flushes on pause', () => {
    const acc = new PlayerWatchAccumulator(30_000);
    let now = 10_000;
    expect(acc.update(7, true, now)).toBeNull();
    now += 30_000;
    expect(acc.tick(now)).toEqual({ episode_id: 7, seconds: 30 });
    now += 12_000;
    expect(acc.update(7, false, now)).toEqual({ episode_id: 7, seconds: 12 });
    // Paused time is never counted
    now += 60_000;
    expect(acc.tick(now)).toBeNull();
  });

  it('normalizes and resolves piecewise sync_points across video time and transcript seeks (#184)', () => {
    const points = normalizePlayerSyncPoints([
      { at_ms: 900_000, offset_ms: -1_200 },
      { at_ms: 0, offset_ms: 9999 },
      { at_ms: -50, offset_ms: 8888 },
      { at_ms: 420_000.4, offset_ms: 2_500.2 },
      { at_ms: 420_000, offset_ms: 2_600 },
    ]);
    expect(points).toEqual([
      { at_ms: 420_000, offset_ms: 2_600 },
      { at_ms: 900_000, offset_ms: -1_200 },
    ]);

    expect(resolvePlayerOffsetAt(0, 400, points)).toBe(400);
    expect(resolvePlayerOffsetAt(419_999, 400, points)).toBe(400);
    expect(resolvePlayerOffsetAt(420_000, 400, points)).toBe(2_600);
    expect(resolvePlayerOffsetAt(899_999, 400, points)).toBe(2_600);
    expect(resolvePlayerOffsetAt(900_000, 400, points)).toBe(-1_200);

    // Seeking to a line before the first cut uses base offset; after cuts uses that stretch's offset
    expect(resolvePlayerOffsetForLine({ start_ms: 100_000 }, 400, points)).toBe(400);
    expect(resolvePlayerOffsetForLine({ start_ms: 500_000 }, 400, points)).toBe(2_600);
    expect(resolvePlayerOffsetForLine({ start_ms: 950_000 }, 400, points)).toBe(-1_200);
  });

  it('scopes manual offset adjustments to the active sync stretch without clobbering other stretches (#184)', () => {
    const points = [
      { at_ms: 420_000, offset_ms: 2_600 },
      { at_ms: 900_000, offset_ms: -1_200 },
    ];

    // Before first point: updates base sub_offset_ms only
    const before = applyPlayerOffsetToActiveStretch(120_000, 400, points, 500);
    expect(before.target).toBe('base');
    expect(before.subOffsetMs).toBe(500);
    expect(before.syncPoints).toEqual(points);
    expect(before.patch).toEqual({ sub_offset_ms: 500 });

    // Inside middle stretch: updates only the 420s point
    const middle = applyPlayerOffsetToActiveStretch(600_000, 400, points, 2_700);
    expect(middle.target).toBe('point');
    expect(middle.pointAtMs).toBe(420_000);
    expect(middle.subOffsetMs).toBe(400);
    expect(middle.syncPoints).toEqual([
      { at_ms: 420_000, offset_ms: 2_700 },
      { at_ms: 900_000, offset_ms: -1_200 },
    ]);
    expect(middle.patch).toEqual({ sync_points: middle.syncPoints });
  });
});
