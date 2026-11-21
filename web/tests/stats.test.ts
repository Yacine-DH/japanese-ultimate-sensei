import { describe, expect, it } from 'vitest';
import type { ActivityDayOut, ProgressPoint } from '../src/api/client';
import {
  buildHeatmapGrid,
  computeActivityScore,
  computeHeatmapLevel,
  computeTrendChartGeometry,
  formatWatchDuration,
} from '../src/lib/stats';

describe('stats heatmap helpers', () => {
  it('fills sparse gaps with zero activity and aligns columns to Sunday..Saturday', () => {
    const active: ActivityDayOut[] = [
      { day: '2026-11-18', minutes: 24, reviews: 10, words_added: 3, words_known: 2 },
      { day: '2026-11-21', minutes: 5, reviews: 0, words_added: 0, words_known: 0 },
    ];
    // 2026-11-15 is Sunday, 2026-11-21 is Saturday -> exact 1 week (7 days)
    const grid = buildHeatmapGrid('2026-11-15', '2026-11-21', active);
    expect(grid.totalDays).toBe(7);
    expect(grid.weeks).toHaveLength(1);
    const week0 = grid.weeks[0]!;
    expect(week0.map((c) => c?.day)).toEqual([
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
    ]);
    // Gap days are level 0
    expect(week0[0]?.level).toBe(0);
    // Active days reflect intensity
    expect(week0[3]?.minutes).toBe(24);
    expect(week0[3]?.level).toBe(3); // score = 24 + 5 + 6 + 4 = 39
    expect(week0[6]?.level).toBe(1); // score = 5
  });

  it('handles a full 365-day year range with leading/trailing null padding', () => {
    const grid = buildHeatmapGrid('2025-11-22', '2026-11-21', [
      { day: '2026-11-21', minutes: 60, reviews: 20, words_added: 5, words_known: 5 },
    ]);
    expect(grid.totalDays).toBe(365);
    expect(grid.weeks.length).toBeGreaterThanOrEqual(52);
    expect(grid.weeks.length).toBeLessThanOrEqual(54);
    for (const week of grid.weeks) {
      expect(week).toHaveLength(7);
    }
    expect(grid.monthLabels.length).toBeGreaterThanOrEqual(11);
  });

  it('maps scores to levels 0..4 monotonically', () => {
    expect(computeHeatmapLevel(0)).toBe(0);
    expect(computeHeatmapLevel(computeActivityScore({ minutes: 0, reviews: 1, words_added: 0, words_known: 0 }))).toBe(1);
    expect(computeHeatmapLevel(15)).toBe(2);
    expect(computeHeatmapLevel(30)).toBe(3);
    expect(computeHeatmapLevel(65)).toBe(4);
  });

  it('formats watch durations cleanly in minutes and hours', () => {
    expect(formatWatchDuration(0)).toBe('0m');
    expect(formatWatchDuration(45)).toBe('45m');
    expect(formatWatchDuration(60)).toBe('1h');
    expect(formatWatchDuration(135)).toBe('2h 15m');
  });
});

describe('computeTrendChartGeometry', () => {
  it('handles empty series cleanly', () => {
    const geom = computeTrendChartGeometry([]);
    expect(geom.tokenCoords).toEqual([]);
    expect(geom.tokenPolyline).toBe('');
    expect(geom.xTicks).toEqual([]);
    expect(geom.yTicks).toHaveLength(5);
  });

  it('centers a single snapshot point horizontally', () => {
    const single: ProgressPoint[] = [
      { day: '2026-11-21', token_pct: 50, unique_pct: 25, unique_words: 400, known_unique: 100 },
    ];
    const geom = computeTrendChartGeometry(single, 600, 200);
    expect(geom.tokenCoords).toHaveLength(1);
    expect(geom.tokenAreaPath).toBe('');
    expect(geom.xTicks).toHaveLength(1);
    const onlyCoord = geom.tokenCoords[0]!;
    expect(onlyCoord.x).toBeGreaterThan(geom.plotLeft);
    expect(onlyCoord.x).toBeLessThan(geom.plotRight);
    // 50% is vertically centered between plotTop and plotBottom
    const expectedMidY = (geom.plotTop + geom.plotBottom) / 2;
    expect(onlyCoord.y).toBeCloseTo(expectedMidY, 1);
  });

  it('generates polylines and area fill for multi-day progress series', () => {
    const series: ProgressPoint[] = [
      { day: '2026-11-18', token_pct: 20, unique_pct: 10, unique_words: 500, known_unique: 50 },
      { day: '2026-11-19', token_pct: 35, unique_pct: 18, unique_words: 500, known_unique: 90 },
      { day: '2026-11-21', token_pct: 60, unique_pct: 32, unique_words: 500, known_unique: 160 },
    ];
    const geom = computeTrendChartGeometry(series);
    expect(geom.tokenCoords).toHaveLength(3);
    expect(geom.tokenCoords[0]!.x).toBe(geom.plotLeft);
    expect(geom.tokenCoords[2]!.x).toBe(geom.plotRight);
    // Higher percentage = smaller SVG y coordinate
    expect(geom.tokenCoords[2]!.y).toBeLessThan(geom.tokenCoords[0]!.y);
    expect(geom.tokenAreaPath).toContain('Z');
    expect(geom.xTicks.map((t) => t.label)).toEqual(['Nov 18', 'Nov 19', 'Nov 21']);
  });
});
