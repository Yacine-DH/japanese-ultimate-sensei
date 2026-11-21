import type { ActivityDayOut, ProgressPoint } from '../api/client';

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatmapCell {
  day: string;
  minutes: number;
  reviews: number;
  words_added: number;
  words_known: number;
  score: number;
  level: HeatmapLevel;
}

export interface HeatmapMonthLabel {
  label: string;
  weekIndex: number;
}

export interface HeatmapGrid {
  /** Columns are Sunday (0) .. Saturday (6); leading/trailing out-of-range slots are null. */
  weeks: (HeatmapCell | null)[][];
  monthLabels: HeatmapMonthLabel[];
  totalDays: number;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
}

export function formatIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function formatShortDate(iso: string): string {
  const dt = parseIsoDate(iso);
  return `${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

export function formatWatchDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  if (safe < 60) {
    return `${safe}m`;
  }
  const hours = Math.floor(safe / 60);
  const rem = safe % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

export function computeActivityScore(
  day: Pick<ActivityDayOut, 'minutes' | 'reviews' | 'words_added' | 'words_known'>,
): number {
  return day.minutes + day.reviews * 0.5 + day.words_added * 2 + day.words_known * 2;
}

export function computeHeatmapLevel(score: number): HeatmapLevel {
  if (score <= 0) return 0;
  if (score < 10) return 1;
  if (score < 25) return 2;
  if (score < 50) return 3;
  return 4;
}

/**
 * Expand sparse active days into a full Sunday-to-Saturday GitHub-style calendar grid
 * spanning `fromDay..toDay` inclusive, filling missing days with zero activity.
 */
export function buildHeatmapGrid(
  fromDay: string,
  toDay: string,
  activeDays: readonly ActivityDayOut[],
): HeatmapGrid {
  const start = parseIsoDate(fromDay);
  const end = parseIsoDate(toDay);
  if (end.getTime() < start.getTime()) {
    return { weeks: [], monthLabels: [], totalDays: 0 };
  }

  const byDay = new Map<string, ActivityDayOut>();
  for (const row of activeDays) {
    byDay.set(row.day, row);
  }

  const weeks: (HeatmapCell | null)[][] = [];
  const monthLabels: HeatmapMonthLabel[] = [];

  let currentWeek: (HeatmapCell | null)[] = new Array<HeatmapCell | null>(start.getUTCDay()).fill(
    null,
  );
  let lastMonth = -1;
  let lastLabelWeek = -10;
  let totalDays = 0;

  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addUtcDays(cursor, 1)) {
    const iso = formatIsoDate(cursor);
    const hit = byDay.get(iso);
    const minutes = hit?.minutes ?? 0;
    const reviews = hit?.reviews ?? 0;
    const words_added = hit?.words_added ?? 0;
    const words_known = hit?.words_known ?? 0;
    const score = computeActivityScore({ minutes, reviews, words_added, words_known });

    const month = cursor.getUTCMonth();
    const weekIndex = weeks.length;
    if (month !== lastMonth) {
      const monthLabel = MONTH_NAMES[month];
      if (monthLabel && weekIndex - lastLabelWeek >= 3) {
        monthLabels.push({ label: monthLabel, weekIndex });
        lastLabelWeek = weekIndex;
      }
      lastMonth = month;
    }

    currentWeek.push({
      day: iso,
      minutes,
      reviews,
      words_added,
      words_known,
      score,
      level: computeHeatmapLevel(score),
    });
    totalDays += 1;

    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) {
      currentWeek.push(null);
    }
    weeks.push(currentWeek);
  }

  return { weeks, monthLabels, totalDays };
}

export interface ChartPointCoord {
  x: number;
  y: number;
  point: ProgressPoint;
}

export interface TrendChartGeometry {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  tokenCoords: ChartPointCoord[];
  uniqueCoords: ChartPointCoord[];
  tokenPolyline: string;
  uniquePolyline: string;
  tokenAreaPath: string;
  yTicks: { value: number; y: number }[];
  xTicks: { label: string; x: number }[];
}

export function computeTrendChartGeometry(
  series: readonly ProgressPoint[],
  width = 640,
  height = 220,
): TrendChartGeometry {
  const plotLeft = 42;
  const plotRight = width - 18;
  const plotTop = 16;
  const plotBottom = height - 28;
  const plotW = Math.max(1, plotRight - plotLeft);
  const plotH = Math.max(1, plotBottom - plotTop);

  const yForPct = (pct: number): number => {
    const clamped = Math.max(0, Math.min(100, pct));
    return Number((plotBottom - (clamped / 100) * plotH).toFixed(1));
  };

  const yTicks = [0, 25, 50, 75, 100].map((value) => ({
    value,
    y: yForPct(value),
  }));

  if (series.length === 0) {
    return {
      width,
      height,
      plotLeft,
      plotRight,
      plotTop,
      plotBottom,
      tokenCoords: [],
      uniqueCoords: [],
      tokenPolyline: '',
      uniquePolyline: '',
      tokenAreaPath: '',
      yTicks,
      xTicks: [],
    };
  }

  const xForIndex = (idx: number): number => {
    if (series.length === 1) {
      return Number((plotLeft + plotW / 2).toFixed(1));
    }
    return Number((plotLeft + (idx / (series.length - 1)) * plotW).toFixed(1));
  };

  const tokenCoords: ChartPointCoord[] = series.map((point, idx) => ({
    x: xForIndex(idx),
    y: yForPct(point.token_pct),
    point,
  }));

  const uniqueCoords: ChartPointCoord[] = series.map((point, idx) => ({
    x: xForIndex(idx),
    y: yForPct(point.unique_pct),
    point,
  }));

  const tokenPolyline = tokenCoords.map((c) => `${c.x},${c.y}`).join(' ');
  const uniquePolyline = uniqueCoords.map((c) => `${c.x},${c.y}`).join(' ');

  let tokenAreaPath = '';
  const firstCoord = tokenCoords[0];
  const lastCoord = tokenCoords[tokenCoords.length - 1];
  if (tokenCoords.length >= 2 && firstCoord && lastCoord) {
    const segments = tokenCoords.map((c) => `L ${c.x} ${c.y}`).join(' ');
    tokenAreaPath = `M ${firstCoord.x} ${plotBottom} ${segments} L ${lastCoord.x} ${plotBottom} Z`;
  }

  const maxXTicks = Math.min(series.length, 6);
  const xTickIndices = new Set<number>();
  if (maxXTicks === 1) {
    xTickIndices.add(0);
  } else {
    for (let i = 0; i < maxXTicks; i++) {
      const idx = Math.round((i / (maxXTicks - 1)) * (series.length - 1));
      xTickIndices.add(idx);
    }
  }
  const xTicks = Array.from(xTickIndices)
    .sort((a, b) => a - b)
    .flatMap((idx) => {
      const pt = series[idx];
      const coord = tokenCoords[idx];
      if (!pt || !coord) return [];
      return [{ label: formatShortDate(pt.day), x: coord.x }];
    });

  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    tokenCoords,
    uniqueCoords,
    tokenPolyline,
    uniquePolyline,
    tokenAreaPath,
    yTicks,
    xTicks,
  };
}
