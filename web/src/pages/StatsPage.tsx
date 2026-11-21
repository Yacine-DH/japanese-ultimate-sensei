import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiClient, type ProgressPoint } from '../api/client';
import {
  buildHeatmapGrid,
  computeTrendChartGeometry,
  formatShortDate,
  formatWatchDuration,
  type HeatmapCell,
  type HeatmapLevel,
} from '../lib/stats';

const LEVEL_CLASSES: Record<HeatmapLevel, string> = {
  0: 'bg-slate-800/80 border-slate-800',
  1: 'bg-emerald-950 border-emerald-900',
  2: 'bg-emerald-700/85 border-emerald-600/80',
  3: 'bg-emerald-500 border-emerald-400/80',
  4: 'bg-emerald-300 border-emerald-200',
};

const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

export function StatsPage() {
  const activityQuery = useQuery({
    queryKey: ['activity'],
    queryFn: () => apiClient.getActivity(),
  });

  const animeQuery = useQuery({
    queryKey: ['anime-list'],
    queryFn: () => apiClient.listAnime(),
  });

  const [selectedAnimeId, setSelectedAnimeId] = useState<number | null>(null);
  const [hoveredCell, setHoveredCell] = useState<HeatmapCell | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<ProgressPoint | null>(null);

  const animeList = animeQuery.data ?? [];
  const activeAnimeId = selectedAnimeId ?? animeList[0]?.id ?? null;

  const progressQuery = useQuery({
    queryKey: ['anime-progress', activeAnimeId],
    queryFn: () => apiClient.getAnimeProgress(activeAnimeId!),
    enabled: activeAnimeId !== null,
  });

  const activity = activityQuery.data;

  const heatmap = useMemo(() => {
    if (!activity) return null;
    return buildHeatmapGrid(activity.from_day, activity.to_day, activity.days);
  }, [activity]);

  const progress = progressQuery.data;
  const chart = useMemo(() => {
    return computeTrendChartGeometry(progress?.series ?? []);
  }, [progress?.series]);

  const trendSummary = useMemo(() => {
    const series = progress?.series ?? [];
    const first = series[0];
    const last = series[series.length - 1];
    if (series.length < 2 || !first || !last) return null;
    return {
      delta: Number((last.token_pct - first.token_pct).toFixed(1)),
      sinceDay: first.day,
    };
  }, [progress?.series]);

  const activeDetailCell = useMemo(() => {
    if (hoveredCell) return hoveredCell;
    if (!activity || activity.days.length === 0) return null;
    const latest = activity.days[activity.days.length - 1];
    if (!latest) return null;
    return {
      ...latest,
      score: 0,
      level: 1 as HeatmapLevel,
    };
  }, [hoveredCell, activity]);

  if (activityQuery.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-100">Progress &amp; Activity</h1>
        <div className="bg-rose-950/40 border border-rose-800/70 rounded-xl p-5 text-sm text-rose-200 space-y-2">
          <div className="font-semibold">Could not load activity stats</div>
          <p className="text-rose-300/90">
            {activityQuery.error instanceof Error
              ? activityQuery.error.message
              : 'Failed to reach the Sensei server.'}
          </p>
          <Link
            to="/settings"
            className="inline-block text-sky-300 hover:text-sky-200 underline underline-offset-2"
          >
            Check server connection in Settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Progress &amp; Activity</h1>
          <p className="text-sm text-slate-400 mt-1">
            Daily immersion consistency and how much of each anime you understand over time.
          </p>
        </div>
        {activity && (
          <div className="text-xs text-slate-500">
            Window: {activity.from_day} → {activity.to_day}
          </div>
        )}
      </div>

      {/* Summary metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">Current Streak</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-emerald-400">
              {activity ? `${activity.current_streak}d` : '—'}
            </span>
            {activity && (
              <span className="text-xs text-slate-500">best {activity.longest_streak}d</span>
            )}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">Watch Time</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-sky-400">
              {activity ? formatWatchDuration(activity.totals.minutes) : '—'}
            </span>
            {activity && (
              <span className="text-xs text-slate-500">{activity.active_days} active days</span>
            )}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">Reviews</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-indigo-300">
              {activity ? activity.totals.reviews.toLocaleString() : '—'}
            </span>
            <span className="text-xs text-slate-500">last 365 days</span>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">Words Known</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-amber-300">
              {activity ? activity.totals.words_known.toLocaleString() : '—'}
            </span>
            {activity && (
              <span className="text-xs text-slate-500">
                +{activity.totals.words_added.toLocaleString()} cards
              </span>
            )}
          </div>
        </div>
      </div>

      {/* GitHub-style Activity Heatmap */}
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Activity Heatmap</h2>
            <p className="text-xs text-slate-400">
              Minutes watched with the subtitle overlay, reviews completed, and vocabulary learned.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span>Less</span>
            {([0, 1, 2, 3, 4] as HeatmapLevel[]).map((lvl) => (
              <span
                key={lvl}
                className={`inline-block w-3 h-3 rounded-[3px] border ${LEVEL_CLASSES[lvl]}`}
                aria-hidden="true"
              />
            ))}
            <span>More</span>
          </div>
        </div>

        {activityQuery.isLoading || !heatmap ? (
          <div className="h-32 rounded-lg bg-slate-800/40 animate-pulse" />
        ) : (
          <>
            <div className="overflow-x-auto pb-1">
              <div className="inline-block min-w-max">
                {/* Month labels */}
                <div className="relative h-4 ml-8 mb-1 text-[11px] text-slate-500">
                  {heatmap.monthLabels.map((m) => (
                    <span
                      key={`${m.label}-${m.weekIndex}`}
                      className="absolute top-0"
                      style={{ left: `${m.weekIndex * 15}px` }}
                    >
                      {m.label}
                    </span>
                  ))}
                </div>

                {/* Weekday labels + 7-row week columns */}
                <div className="flex gap-1.5">
                  <div className="grid grid-rows-7 gap-[3px] pr-1 text-[10px] text-slate-500 leading-3 w-7 text-right">
                    {WEEKDAY_LABELS.map((label, idx) => (
                      <span key={idx} className="h-3 flex items-center justify-end">
                        {label}
                      </span>
                    ))}
                  </div>

                  <div
                    className="flex gap-[3px]"
                    onMouseLeave={() => setHoveredCell(null)}
                    role="grid"
                    aria-label="Daily learning activity heatmap"
                  >
                    {heatmap.weeks.map((week, wIdx) => (
                      <div key={wIdx} className="grid grid-rows-7 gap-[3px]" role="row">
                        {week.map((cell, dIdx) => {
                          if (!cell) {
                            return <div key={dIdx} className="w-3 h-3" aria-hidden="true" />;
                          }
                          const isSelected = hoveredCell?.day === cell.day;
                          const title = `${cell.day}: ${cell.minutes}m watched, ${cell.reviews} reviews, ${cell.words_added} cards, ${cell.words_known} words known`;
                          return (
                            <button
                              key={cell.day}
                              type="button"
                              title={title}
                              aria-label={title}
                              onMouseEnter={() => setHoveredCell(cell)}
                              onFocus={() => setHoveredCell(cell)}
                              className={`w-3 h-3 rounded-[3px] border transition-transform ${
                                LEVEL_CLASSES[cell.level]
                              } ${isSelected ? 'ring-1 ring-sky-300 scale-110' : 'hover:scale-110'}`}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Day inspector bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-xs">
              {activeDetailCell ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-300">
                  <span className="font-semibold text-slate-100">
                    {hoveredCell ? activeDetailCell.day : `Latest active day · ${activeDetailCell.day}`}
                  </span>
                  <span>
                    <strong className="text-sky-300">{activeDetailCell.minutes}m</strong> watched
                  </span>
                  <span>
                    <strong className="text-indigo-300">{activeDetailCell.reviews}</strong> reviews
                  </span>
                  <span>
                    <strong className="text-emerald-300">{activeDetailCell.words_known}</strong> known
                  </span>
                  <span>
                    <strong className="text-amber-300">{activeDetailCell.words_added}</strong> cards
                  </span>
                </div>
              ) : (
                <div className="text-slate-400">
                  No activity recorded yet — watch an episode with the extension overlay or complete a review to light up today&apos;s square.
                </div>
              )}
              <div className="text-slate-500">Hover or focus any day for details</div>
            </div>
          </>
        )}
      </section>

      {/* Per-Anime Understanding Progress */}
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Anime Understanding Over Time
            </h2>
            <p className="text-xs text-slate-400">
              Weighted % of dialogue words you know across an anime&apos;s imported episodes.
            </p>
          </div>
        </div>

        {animeQuery.isLoading ? (
          <div className="h-44 rounded-lg bg-slate-800/40 animate-pulse" />
        ) : animeList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-400 space-y-2">
            <p>Import your first episode to track how much of an anime you understand.</p>
            <Link
              to="/"
              className="inline-block px-3 py-1.5 rounded-lg bg-sky-500/20 border border-sky-500/40 text-sky-300 hover:bg-sky-500/30 font-medium"
            >
              Go to Library
            </Link>
          </div>
        ) : (
          <>
            {/* Anime selector cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {animeList.map((anime) => {
                const selected = anime.id === activeAnimeId;
                return (
                  <button
                    key={anime.id}
                    type="button"
                    onClick={() => {
                      setSelectedAnimeId(anime.id);
                      setHoveredPoint(null);
                    }}
                    className={`text-left rounded-xl p-3.5 border transition-colors ${
                      selected
                        ? 'bg-sky-500/15 border-sky-400/60'
                        : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-sm text-slate-100 truncate">
                          {anime.title}
                        </div>
                        {anime.title_jp && (
                          <div className="text-xs text-slate-400 truncate">{anime.title_jp}</div>
                        )}
                      </div>
                      <span className="shrink-0 text-sm font-bold text-sky-300">
                        {anime.token_pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-sky-500 to-emerald-400"
                        style={{ width: `${Math.min(100, Math.max(0, anime.token_pct))}%` }}
                      />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
                      <span>
                        {anime.episode_count} {anime.episode_count === 1 ? 'episode' : 'episodes'}
                      </span>
                      <span>
                        {anime.known_unique.toLocaleString()} / {anime.unique_words.toLocaleString()}{' '}
                        unique
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Selected anime trend chart + episode breakdown */}
            {progressQuery.isLoading ? (
              <div className="h-56 rounded-lg bg-slate-800/40 animate-pulse" />
            ) : progress ? (
              <div className="space-y-5 pt-2 border-t border-slate-800/80">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-slate-100">{progress.anime.title}</h3>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400 mt-0.5">
                      <span>
                        Dialogue understood:{' '}
                        <strong className="text-sky-300">
                          {progress.anime.token_pct.toFixed(1)}%
                        </strong>
                      </span>
                      <span>
                        Unique words:{' '}
                        <strong className="text-emerald-300">
                          {progress.anime.unique_pct.toFixed(1)}%
                        </strong>{' '}
                        ({progress.anime.known_unique.toLocaleString()} /{' '}
                        {progress.anime.unique_words.toLocaleString()})
                      </span>
                      {trendSummary !== null && (
                        <span
                          className={
                            trendSummary.delta >= 0
                              ? 'text-emerald-400 font-medium'
                              : 'text-rose-400'
                          }
                        >
                          {trendSummary.delta >= 0
                            ? `+${trendSummary.delta}%`
                            : `${trendSummary.delta}%`}{' '}
                          since {formatShortDate(trendSummary.sinceDay)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-slate-400">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-0.5 bg-sky-400" />
                      Dialogue %
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-0.5 border-t-2 border-dashed border-emerald-400" />
                      Unique words %
                    </span>
                  </div>
                </div>

                {/* SVG Line Chart */}
                <div className="bg-slate-950/70 border border-slate-800/90 rounded-xl p-4 space-y-2">
                  {chart.tokenCoords.length === 0 ? (
                    <div className="py-10 text-center text-xs text-slate-500">
                      No daily snapshots yet for this anime.
                    </div>
                  ) : (
                    <>
                      <svg
                        viewBox={`0 0 ${chart.width} ${chart.height}`}
                        className="w-full h-56 overflow-visible"
                        role="img"
                        aria-label={`Understanding progress chart for ${progress.anime.title}`}
                        onMouseLeave={() => setHoveredPoint(null)}
                      >
                        <defs>
                          <linearGradient id="senseiTokenFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.28" />
                            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.0" />
                          </linearGradient>
                        </defs>

                        {/* Horizontal grid lines + Y labels */}
                        {chart.yTicks.map((tick) => (
                          <g key={tick.value}>
                            <line
                              x1={chart.plotLeft}
                              y1={tick.y}
                              x2={chart.plotRight}
                              y2={tick.y}
                              stroke="#1e293b"
                              strokeWidth="1"
                            />
                            <text
                              x={chart.plotLeft - 8}
                              y={tick.y + 4}
                              textAnchor="end"
                              fill="#64748b"
                              fontSize="11"
                            >
                              {tick.value}%
                            </text>
                          </g>
                        ))}

                        {/* Area fill under token_pct */}
                        {chart.tokenAreaPath && (
                          <path d={chart.tokenAreaPath} fill="url(#senseiTokenFill)" />
                        )}

                        {/* Unique % dashed line */}
                        {chart.uniqueCoords.length >= 2 && (
                          <polyline
                            fill="none"
                            stroke="#34d399"
                            strokeWidth="2"
                            strokeDasharray="5 4"
                            points={chart.uniquePolyline}
                          />
                        )}

                        {/* Dialogue token % line */}
                        {chart.tokenCoords.length >= 2 && (
                          <polyline
                            fill="none"
                            stroke="#38bdf8"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            points={chart.tokenPolyline}
                          />
                        )}

                        {/* Interactive points */}
                        {chart.tokenCoords.map((coord) => {
                          const isActive = hoveredPoint?.day === coord.point.day;
                          return (
                            <g key={coord.point.day}>
                              <circle
                                cx={coord.x}
                                cy={coord.y}
                                r={isActive ? 5.5 : 3.5}
                                fill="#38bdf8"
                                stroke="#0f172a"
                                strokeWidth="1.5"
                                className="cursor-pointer"
                                onMouseEnter={() => setHoveredPoint(coord.point)}
                              />
                              <circle
                                cx={coord.x}
                                cy={coord.y}
                                r="12"
                                fill="transparent"
                                className="cursor-pointer"
                                onMouseEnter={() => setHoveredPoint(coord.point)}
                              />
                            </g>
                          );
                        })}

                        {chart.uniqueCoords.map((coord) => (
                          <circle
                            key={`u-${coord.point.day}`}
                            cx={coord.x}
                            cy={coord.y}
                            r="2.5"
                            fill="#34d399"
                            stroke="#0f172a"
                            strokeWidth="1"
                            className="pointer-events-none"
                          />
                        ))}

                        {/* X axis date labels */}
                        {chart.xTicks.map((tick) => (
                          <text
                            key={`${tick.label}-${tick.x}`}
                            x={tick.x}
                            y={chart.height - 6}
                            textAnchor="middle"
                            fill="#64748b"
                            fontSize="11"
                          >
                            {tick.label}
                          </text>
                        ))}
                      </svg>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/70 text-xs text-slate-300">
                        {(() => {
                          const displayPoint =
                            hoveredPoint ?? progress.series[progress.series.length - 1];
                          if (!displayPoint) return null;
                          return (
                            <>
                              <span>
                                <strong className="text-slate-100">{displayPoint.day}</strong>
                                {hoveredPoint ? '' : ' (latest snapshot)'}
                              </span>
                              <div className="flex flex-wrap gap-4">
                                <span>
                                  Dialogue:{' '}
                                  <strong className="text-sky-300">
                                    {displayPoint.token_pct.toFixed(1)}%
                                  </strong>
                                </span>
                                <span>
                                  Unique:{' '}
                                  <strong className="text-emerald-300">
                                    {displayPoint.unique_pct.toFixed(1)}%
                                  </strong>{' '}
                                  ({displayPoint.known_unique.toLocaleString()} /{' '}
                                  {displayPoint.unique_words.toLocaleString()})
                                </span>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    </>
                  )}
                </div>

                {/* Per-Episode Breakdown */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Episodes ({progress.episodes.length})
                  </h4>
                  <div className="divide-y divide-slate-800/80 border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40">
                    {progress.episodes.map((ep) => (
                      <Link
                        key={ep.episode_id}
                        to={`/episodes/${ep.episode_id}`}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-slate-800/40 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-slate-100 truncate">
                            {ep.number !== null ? `Ep ${ep.number}` : `Episode #${ep.episode_id}`}
                            {ep.title ? ` · ${ep.title}` : ''}
                          </div>
                          <div className="text-xs text-slate-500">
                            Unique known: {ep.unique_pct.toFixed(1)}% · Watched:{' '}
                            {formatWatchDuration(ep.minutes_watched)}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 w-44 sm:w-56">
                          <div className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden">
                            <div
                              className="h-full bg-sky-400"
                              style={{ width: `${Math.min(100, Math.max(0, ep.token_pct))}%` }}
                            />
                          </div>
                          <span className="w-12 text-right text-sm font-semibold text-sky-300">
                            {ep.token_pct.toFixed(1)}%
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
