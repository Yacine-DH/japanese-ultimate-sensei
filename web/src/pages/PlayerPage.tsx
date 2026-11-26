import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  type EpisodePatch,
  type LineOut,
  type SyncPoint,
  type TokenOut,
  type WordStatus,
} from '../api/client';
import { MarkdownContent } from '../components/MarkdownContent';
import { MissedWordsPanel } from '../components/MissedWordsPanel';
import { TranscribePanel } from '../components/TranscribePanel';
import {
  applyPlayerOffsetToActiveStretch,
  captureLocalVideoScreenshot,
  computePlayerSeekSeconds,
  computeSyncOffsetMs,
  findActivePlayerLines,
  findPlayerLineToReplay,
  findReferenceLineForSync,
  formatOffsetLabel,
  isEditableElement,
  isSupportedVideoFile,
  normalizePlayerSyncPoints,
  PLAYER_OFFSET_STEP_MS,
  PLAYER_SLOW_REPLAY_RATE,
  PlayerWatchAccumulator,
  rankPlayerHighlightIndices,
  recordLocalLineAudio,
  resolvePlayerOffsetAt,
  resolvePlayerOffsetForLine,
  shouldAutoPauseAfterLine,
} from '../lib/player';
import { type GlossLanguage, loadWebSettings } from '../lib/settings';
import {
  formatTimestampMs,
  getTranscriptLineRomaji,
  isTokenLookupable,
  pickEntrySenses,
  shouldShowFurigana,
  updateWordStatusInTranscript,
} from '../lib/transcript';

type TranslationMode = 'off' | 'en' | 'de';

export function PlayerPage() {
  const { id } = useParams<{ id?: string }>();
  const routeEpisodeId = id ? Number(id) : null;
  const queryClient = useQueryClient();
  const initialSettings = useMemo(() => loadWebSettings(), []);

  const [selectedEpisodeId, setSelectedEpisodeId] = useState<number | null>(
    routeEpisodeId && Number.isFinite(routeEpisodeId) ? routeEpisodeId : null,
  );
  const [explicitDetached, setExplicitDetached] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string>('');
  const [dragActive, setDragActive] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [showTranscribe, setShowTranscribe] = useState(false);

  const [subOffsetMs, setSubOffsetMs] = useState(0);
  const [syncPoints, setSyncPoints] = useState<SyncPoint[]>([]);
  const [activeOffsetMs, setActiveOffsetMs] = useState(0);
  const [activeLines, setActiveLines] = useState<LineOut[]>([]);
  const [showRomaji, setShowRomaji] = useState(initialSettings.romaji);
  const [glossLang, setGlossLang] = useState<GlossLanguage>(initialSettings.glossLang);
  const [translationMode, setTranslationMode] = useState<TranslationMode>('off');
  const [revealedLineId, setRevealedLineId] = useState<number | null>(null);
  const [pauseOnHover, setPauseOnHover] = useState(true);
  const [autoPause, setAutoPause] = useState(false);
  const [showTranscript, setShowTranscript] = useState(true);
  const [showMissed, setShowMissed] = useState(false);

  const [popupToken, setPopupToken] = useState<TokenOut | null>(null);
  const [popupLine, setPopupLine] = useState<LineOut | null>(null);
  const [explainLine, setExplainLine] = useState<LineOut | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pausedByHoverRef = useRef(false);
  const prevActiveIdsRef = useRef<number[]>([]);
  const skipAutoPauseOnceRef = useRef(false);
  const slowReplayEndMsRef = useRef<{ endMs: number; originalRate: number } | null>(null);
  const offsetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef(new PlayerWatchAccumulator());

  const showToast = useCallback((msg: string, ms = 2200) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
  }, []);

  const episodesQuery = useQuery({
    queryKey: ['episodes'],
    queryFn: () => apiClient.listEpisodes(),
    staleTime: 60_000,
  });

  const activeEpisodeId = explicitDetached
    ? null
    : (selectedEpisodeId ?? (routeEpisodeId ? null : (episodesQuery.data?.[0]?.id ?? null)));

  const episodeQuery = useQuery({
    queryKey: ['episode', activeEpisodeId],
    queryFn: () => apiClient.getEpisode(activeEpisodeId!),
    enabled: activeEpisodeId !== null,
  });

  const linesQuery = useQuery({
    queryKey: ['episode-lines', activeEpisodeId],
    queryFn: () => apiClient.getEpisodeLines(activeEpisodeId!),
    enabled: activeEpisodeId !== null,
  });

  const llmStatusQuery = useQuery({
    queryKey: ['llm-status'],
    queryFn: () => apiClient.getLlmStatus(),
    staleTime: 60_000,
    retry: false,
  });

  const lookupQuery = useQuery({
    queryKey: ['dict-lookup', popupToken?.word_id, popupToken?.lemma, popupToken?.lemma_reading],
    queryFn: () =>
      apiClient.lookupDictionary(
        popupToken!.lemma,
        popupToken!.lemma_reading,
        4,
        popupToken!.word_id,
      ),
    enabled: popupToken !== null,
    retry: false,
  });

  const explainLang = glossLang === 'ger' ? 'de' : 'en';
  const explainQuery = useQuery({
    queryKey: ['line-explain', explainLine?.id, explainLang],
    queryFn: () => apiClient.explainLine(explainLine!.id, explainLang),
    enabled: explainLine !== null && Boolean(llmStatusQuery.data?.configured),
    retry: false,
  });

  const lines = useMemo(() => linesQuery.data ?? [], [linesQuery.data]);
  const llmConfigured = Boolean(llmStatusQuery.data?.configured);

  // Sync subOffsetMs and piecewise sync_points when episode loads or changes
  useEffect(() => {
    if (offsetTimerRef.current) {
      clearTimeout(offsetTimerRef.current);
      offsetTimerRef.current = null;
    }
    if (episodeQuery.data) {
      const base = episodeQuery.data.sub_offset_ms;
      const pts = normalizePlayerSyncPoints(episodeQuery.data.sync_points);
      setSubOffsetMs(base);
      setSyncPoints(pts);
      const videoMs = (videoRef.current?.currentTime ?? 0) * 1000;
      setActiveOffsetMs(resolvePlayerOffsetAt(videoMs, base, pts));
    } else {
      setSubOffsetMs(0);
      setSyncPoints([]);
      setActiveOffsetMs(0);
    }
  }, [episodeQuery.data]);

  // Revoke object URL cleanly on change or unmount
  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  const dispatchHeartbeat = useCallback((payload: { episode_id: number; seconds: number } | null) => {
    if (!payload) return;
    void apiClient.sendWatchHeartbeat(payload).catch(() => {});
  }, []);

  // Periodic watch-time heartbeat flush + pagehide/unmount flush
  useEffect(() => {
    const idInterval = setInterval(() => {
      dispatchHeartbeat(heartbeatRef.current.tick(Date.now()));
    }, 5_000);
    const onPageHide = () => {
      dispatchHeartbeat(heartbeatRef.current.flush(Date.now(), true));
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      clearInterval(idInterval);
      window.removeEventListener('pagehide', onPageHide);
      dispatchHeartbeat(heartbeatRef.current.flush(Date.now(), true));
    };
  }, [dispatchHeartbeat]);

  const persistOffset = useCallback(
    (epId: number, patch: EpisodePatch) => {
      if (offsetTimerRef.current) clearTimeout(offsetTimerRef.current);
      offsetTimerRef.current = setTimeout(() => {
        void apiClient
          .patchEpisode(epId, patch)
          .then((updated) => {
            queryClient.setQueryData(['episode', epId], updated);
          })
          .catch(() => {});
      }, 400);
    },
    [queryClient],
  );

  const syncFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || lines.length === 0) {
      setActiveLines((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const videoMs = video.currentTime * 1000;
    const slowState = slowReplayEndMsRef.current;
    if (slowState && videoMs >= slowState.endMs) {
      video.playbackRate = slowState.originalRate;
      slowReplayEndMsRef.current = null;
    }

    const effectiveOffsetMs = resolvePlayerOffsetAt(videoMs, subOffsetMs, syncPoints);
    setActiveOffsetMs((prev) => (prev === effectiveOffsetMs ? prev : effectiveOffsetMs));

    const nextActive = findActivePlayerLines(lines, videoMs, effectiveOffsetMs);
    const nextIds = nextActive.map((l) => l.id);

    if (
      !capturing &&
      !video.paused &&
      !skipAutoPauseOnceRef.current &&
      shouldAutoPauseAfterLine(prevActiveIdsRef.current, nextIds, autoPause)
    ) {
      video.pause();
      showToast('Paused at end of line (study mode)', 1500);
    }
    skipAutoPauseOnceRef.current = false;

    const prevKey = prevActiveIdsRef.current.join(',');
    const nextKey = nextIds.join(',');
    if (prevKey !== nextKey) {
      prevActiveIdsRef.current = nextIds;
      setActiveLines(nextActive);
      setRevealedLineId(null);
    }
  }, [lines, subOffsetMs, syncPoints, autoPause, capturing, showToast]);

  // Keep subtitles synced smoothly while playing
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let rafId: number | null = null;
    let rvfcId: number | null = null;
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };

    const stopLoop = () => {
      if (rvfcId !== null && v.cancelVideoFrameCallback) {
        v.cancelVideoFrameCallback(rvfcId);
        rvfcId = null;
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const startLoop = () => {
      stopLoop();
      if (video.paused || video.ended) return;
      if (typeof v.requestVideoFrameCallback === 'function') {
        const tick = () => {
          rvfcId = null;
          syncFrame();
          if (!video.paused && !video.ended) {
            rvfcId = v.requestVideoFrameCallback!(tick);
          }
        };
        rvfcId = v.requestVideoFrameCallback(tick);
      } else {
        const tick = () => {
          rafId = null;
          syncFrame();
          if (!video.paused && !video.ended) {
            rafId = requestAnimationFrame(tick);
          }
        };
        rafId = requestAnimationFrame(tick);
      }
    };

    const onPlay = () => {
      startLoop();
      dispatchHeartbeat(heartbeatRef.current.update(activeEpisodeId, true, Date.now()));
    };
    const onPause = () => {
      stopLoop();
      dispatchHeartbeat(heartbeatRef.current.update(activeEpisodeId, false, Date.now()));
    };
    const onEnded = () => {
      onPause();
      if (activeEpisodeId !== null) {
        setShowMissed(true);
      }
    };
    const onWaiting = () => {
      dispatchHeartbeat(heartbeatRef.current.update(activeEpisodeId, false, Date.now()));
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('playing', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('timeupdate', syncFrame);
    video.addEventListener('seeked', syncFrame);

    syncFrame();
    if (!video.paused && !video.ended) {
      startLoop();
    }

    return () => {
      stopLoop();
      video.removeEventListener('play', onPlay);
      video.removeEventListener('playing', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('timeupdate', syncFrame);
      video.removeEventListener('seeked', syncFrame);
    };
  }, [videoUrl, syncFrame, activeEpisodeId, dispatchHeartbeat]);

  const statusMutation = useMutation({
    mutationFn: ({ wordId, status }: { wordId: number; status: WordStatus }) =>
      apiClient.setWordStatus(wordId, status),
    onSuccess: (updated) => {
      if (activeEpisodeId !== null) {
        queryClient.setQueryData<LineOut[]>(['episode-lines', activeEpisodeId], (prev) =>
          prev ? updateWordStatusInTranscript(prev, updated.id, updated.status) : prev,
        );
        void queryClient.invalidateQueries({ queryKey: ['understanding', activeEpisodeId] });
      }
      setActiveLines((prev) => updateWordStatusInTranscript(prev, updated.id, updated.status));
      setPopupToken((prev) =>
        prev && prev.word_id === updated.id ? { ...prev, status: updated.status } : prev,
      );
      showToast(
        updated.status === 'known'
          ? `Known: ${updated.lemma}`
          : updated.status === 'ignored'
            ? `Ignored: ${updated.lemma}`
            : `Updated: ${updated.lemma}`,
      );
    },
  });

  const handleSaveCardWithCapture = useCallback(
    async (token: TokenOut, line: LineOut | null) => {
      if (token.word_id === null || capturing) return;
      const video = videoRef.current;
      setCapturing(true);
      showToast(`Capturing scene for ${token.lemma}…`, 15_000);

      try {
        const mediaIds: number[] = [];
        const capturedKinds: string[] = [];

        if (video) {
          const shot = await captureLocalVideoScreenshot(video);
          if (shot) {
            try {
              const uploaded = await apiClient.uploadMedia({
                file: shot.blob,
                filename: shot.filename,
                kind: 'screenshot',
              });
              mediaIds.push(uploaded.id);
              capturedKinds.push('screenshot');
            } catch {
              // Screenshot optional if ffmpeg unavailable
            }
          }
          if (line) {
            skipAutoPauseOnceRef.current = true;
            const effectiveOffsetMs = resolvePlayerOffsetAt(
              video.currentTime * 1000,
              subOffsetMs,
              syncPoints,
            );
            const audio = await recordLocalLineAudio(video, line, effectiveOffsetMs);
            if (audio) {
              try {
                const uploaded = await apiClient.uploadMedia({
                  file: audio.blob,
                  filename: audio.filename,
                  kind: 'audio',
                });
                mediaIds.push(uploaded.id);
                capturedKinds.push('audio');
              } catch {
                // Audio optional
              }
            }
          }
        }

        const created = await apiClient.createCard({
          word_id: token.word_id,
          line_id: line?.id ?? null,
          media_ids: mediaIds,
        });

        if (activeEpisodeId !== null) {
          queryClient.setQueryData<LineOut[]>(['episode-lines', activeEpisodeId], (prev) =>
            prev ? updateWordStatusInTranscript(prev, token.word_id!, 'learning') : prev,
          );
          void queryClient.invalidateQueries({ queryKey: ['understanding', activeEpisodeId] });
          void queryClient.invalidateQueries({ queryKey: ['reviews-due'] });
        }
        setActiveLines((prev) => updateWordStatusInTranscript(prev, token.word_id!, 'learning'));
        setPopupToken((prev) =>
          prev && prev.word_id === token.word_id ? { ...prev, status: 'learning' } : prev,
        );
        showToast(
          `${created.created ? 'Saved ✓' : 'Updated ✓'} ${token.lemma}${
            capturedKinds.length > 0 ? ` (${capturedKinds.join(' + ')})` : ''
          }`,
          2800,
        );
      } catch (err) {
        showToast(`Save failed: ${err instanceof Error ? err.message : 'Error'}`, 3000);
      } finally {
        setCapturing(false);
      }
    },
    [capturing, subOffsetMs, syncPoints, activeEpisodeId, queryClient, showToast],
  );

  const openTokenPopup = useCallback(
    (token: TokenOut, line: LineOut) => {
      const video = videoRef.current;
      if (pauseOnHover && video && !video.paused) {
        video.pause();
        pausedByHoverRef.current = true;
      }
      setPopupToken(token);
      setPopupLine(line);
    },
    [pauseOnHover],
  );

  const closeTokenPopup = useCallback(() => {
    setPopupToken(null);
    setPopupLine(null);
    const video = videoRef.current;
    if (pausedByHoverRef.current && video && video.paused) {
      pausedByHoverRef.current = false;
      void video.play().catch(() => {});
    }
  }, []);

  const shiftOffset = useCallback(
    (deltaMs: number) => {
      const videoMs = (videoRef.current?.currentTime ?? 0) * 1000;
      const effectiveOffsetMs = resolvePlayerOffsetAt(videoMs, subOffsetMs, syncPoints);
      const updated = applyPlayerOffsetToActiveStretch(
        videoMs,
        subOffsetMs,
        syncPoints,
        effectiveOffsetMs + deltaMs,
      );
      setSubOffsetMs(updated.subOffsetMs);
      setSyncPoints(updated.syncPoints);
      setActiveOffsetMs(updated.offsetMs);
      const toastText =
        updated.target === 'point' && updated.pointAtMs !== null
          ? `Sub offset (from ${formatTimestampMs(updated.pointAtMs)}): ${formatOffsetLabel(updated.offsetMs)}`
          : `Sub offset: ${formatOffsetLabel(updated.offsetMs)}`;
      showToast(toastText, 1400);
      if (activeEpisodeId !== null) {
        persistOffset(activeEpisodeId, updated.patch);
      }
    },
    [subOffsetMs, syncPoints, activeEpisodeId, persistOffset, showToast],
  );

  const syncLineNow = useCallback(() => {
    const video = videoRef.current;
    if (!video || lines.length === 0) return;
    const videoMs = video.currentTime * 1000;
    const effectiveOffsetMs = resolvePlayerOffsetAt(videoMs, subOffsetMs, syncPoints);
    const refLine = findReferenceLineForSync(lines, videoMs, effectiveOffsetMs);
    if (!refLine) return;
    const next = computeSyncOffsetMs(videoMs, refLine);
    const updated = applyPlayerOffsetToActiveStretch(videoMs, subOffsetMs, syncPoints, next);
    setSubOffsetMs(updated.subOffsetMs);
    setSyncPoints(updated.syncPoints);
    setActiveOffsetMs(updated.offsetMs);
    const toastText =
      updated.target === 'point' && updated.pointAtMs !== null
        ? `Synced line (from ${formatTimestampMs(updated.pointAtMs)}): ${formatOffsetLabel(updated.offsetMs)}`
        : `Synced line: ${formatOffsetLabel(updated.offsetMs)}`;
    showToast(toastText, 1600);
    if (activeEpisodeId !== null) {
      persistOffset(activeEpisodeId, updated.patch);
    }
  }, [lines, subOffsetMs, syncPoints, activeEpisodeId, persistOffset, showToast]);

  const replayLine = useCallback(
    (slow: boolean) => {
      const video = videoRef.current;
      if (!video || lines.length === 0) return;
      const videoMs = video.currentTime * 1000;
      const effectiveOffsetMs = resolvePlayerOffsetAt(videoMs, subOffsetMs, syncPoints);
      const target = findPlayerLineToReplay(lines, videoMs, effectiveOffsetMs);
      if (!target) {
        showToast('No subtitle line to replay');
        return;
      }
      if (slow) {
        const originalRate = slowReplayEndMsRef.current?.originalRate ?? video.playbackRate;
        slowReplayEndMsRef.current = {
          endMs: target.end_ms + effectiveOffsetMs + 150,
          originalRate,
        };
        video.playbackRate = PLAYER_SLOW_REPLAY_RATE;
        showToast(`Slow replay (${PLAYER_SLOW_REPLAY_RATE}×)`);
      } else {
        if (slowReplayEndMsRef.current) {
          video.playbackRate = slowReplayEndMsRef.current.originalRate;
          slowReplayEndMsRef.current = null;
        }
        showToast('Replay line');
      }
      skipAutoPauseOnceRef.current = true;
      pausedByHoverRef.current = false;
      video.currentTime = computePlayerSeekSeconds(target, effectiveOffsetMs);
      void video.play().catch(() => {});
    },
    [lines, subOffsetMs, syncPoints, showToast],
  );

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen?.().catch(() => {});
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || isEditableElement(e.target)) return;

      if (e.code === 'Escape') {
        if (popupToken) {
          e.preventDefault();
          closeTokenPopup();
          return;
        }
        if (explainLine) {
          e.preventDefault();
          setExplainLine(null);
          return;
        }
      }

      if (popupToken && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.code === 'KeyK' && popupToken.word_id !== null) {
          e.preventDefault();
          statusMutation.mutate({ wordId: popupToken.word_id, status: 'known' });
          return;
        }
        if (e.code === 'KeyI' && popupToken.word_id !== null) {
          e.preventDefault();
          statusMutation.mutate({ wordId: popupToken.word_id, status: 'ignored' });
          return;
        }
        if (e.code === 'KeyS' && popupToken.word_id !== null) {
          e.preventDefault();
          void handleSaveCardWithCapture(popupToken, popupLine);
          return;
        }
      }

      if (!videoUrl || lines.length === 0) return;

      if (e.code === 'BracketLeft' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        shiftOffset(-PLAYER_OFFSET_STEP_MS);
      } else if (e.code === 'BracketRight' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        shiftOffset(PLAYER_OFFSET_STEP_MS);
      } else if (e.code === 'Backslash' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        syncLineNow();
      } else if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        replayLine(e.shiftKey);
      } else if (e.code === 'KeyP' && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setAutoPause((prev) => {
          showToast(`Study auto-pause: ${!prev ? 'ON' : 'OFF'}`);
          return !prev;
        });
      } else if (e.code === 'KeyT' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const line = activeLines[activeLines.length - 1];
        if (line) {
          e.preventDefault();
          setRevealedLineId((prev) => (prev === line.id ? null : line.id));
        }
      } else if (e.code === 'KeyE' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const line = activeLines[activeLines.length - 1];
        if (line && llmConfigured) {
          e.preventDefault();
          videoRef.current?.pause();
          setExplainLine(line);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    popupToken,
    popupLine,
    explainLine,
    videoUrl,
    lines.length,
    activeLines,
    llmConfigured,
    closeTokenPopup,
    statusMutation,
    handleSaveCardWithCapture,
    shiftOffset,
    syncLineNow,
    replayLine,
    showToast,
  ]);

  function loadLocalVideoFile(file: File | null): void {
    if (!file) return;
    if (!isSupportedVideoFile(file)) {
      setVideoError(`"${file.name}" does not look like a video file (.mp4, .webm, .mkv, .mov).`);
      return;
    }
    setVideoError(null);
    setVideoFile(file);
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setVideoName(file.name);
    setActiveLines([]);
    prevActiveIdsRef.current = [];
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0] ?? null;
    loadLocalVideoFile(file);
  }

  const topEntry = lookupQuery.data?.entries[0] ?? null;
  const pickedSenses = topEntry ? pickEntrySenses(topEntry, glossLang) : null;
  const activeIdSet = useMemo(() => new Set(activeLines.map((l) => l.id)), [activeLines]);

  return (
    <div className="space-y-5">
      {/* Header + Episode Selector */}
      <div className="headline flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Built-In Video Player</h1>
          <p className="text-xs text-muted mt-0.5">
            Play downloaded episodes locally in your browser with interactive furigana subtitles,
            dictionary lookup, and instant scene-card capture.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Select episode subtitles"
            value={activeEpisodeId ?? ''}
            onChange={(e) => {
              const next = e.target.value ? Number(e.target.value) : null;
              setSelectedEpisodeId(next);
              setExplicitDetached(next === null);
              setActiveLines([]);
              prevActiveIdsRef.current = [];
              setPopupToken(null);
              setExplainLine(null);
            }}
            className="rounded-lg bg-paper border border-line-2 px-3 py-1.5 text-xs text-ink max-w-xs"
          >
            <option value="">
              {(episodesQuery.data ?? []).length === 0
                ? 'No episodes imported yet'
                : 'None (no subtitles attached)'}
            </option>
            {(episodesQuery.data ?? []).map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.anime_title ?? 'Episode'}
                {ep.number !== null ? ` Ep ${ep.number}` : ''} ({ep.line_count} lines)
              </option>
            ))}
          </select>

          <label className="btn btn-sun px-3 py-1.5 text-xs font-semibold cursor-pointer transition">
            <span>{videoUrl ? 'Change Video File' : 'Open Video File…'}</span>
            <input
              type="file"
              accept="video/*,.mkv,.mp4,.webm,.mov"
              className="hidden"
              onChange={(e) => loadLocalVideoFile(e.target.files?.[0] ?? null)}
            />
          </label>

          {videoFile && (
            <button
              type="button"
              onClick={() => setShowTranscribe((v) => !v)}
              className="btn btn-plum px-3 py-1.5 text-xs font-semibold cursor-pointer transition"
            >
              {showTranscribe ? 'Hide Transcribe' : 'Transcribe this file'}
            </button>
          )}

          {activeEpisodeId !== null && (
            <Link
              to={`/episodes/${activeEpisodeId}`}
              className="btn px-3 py-1.5 text-xs font-medium text-ink-2"
            >
              Episode Details
            </Link>
          )}
        </div>
      </div>

      {videoFile && activeEpisodeId === null && !showTranscribe && (
        <div className="rounded-xl bg-plum/20 border border-plum/55 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="text-plum-ink">
            No episode subtitles attached to <span className="font-semibold">{videoName}</span>.
            Need Japanese subtitles generated from this file?
          </div>
          <button
            type="button"
            onClick={() => setShowTranscribe(true)}
            className="btn btn-plum px-3 py-1.5 font-semibold cursor-pointer"
          >
            Transcribe this file
          </button>
        </div>
      )}

      {showTranscribe && videoFile && (
        <TranscribePanel
          initialFile={videoFile}
          heading="Transcribe this file"
          showAttachButton
          onEpisodeReady={(episodeId) => {
            setExplicitDetached(false);
            setSelectedEpisodeId(episodeId);
            setActiveLines([]);
            prevActiveIdsRef.current = [];
            showToast('Subtitles ready & attached to player!', 3200);
          }}
          onClose={() => setShowTranscribe(false)}
        />
      )}

      {videoError && (
        <div className="rounded-xl bg-rose/25 border border-rose/90 px-4 py-2.5 text-xs text-rose-ink">
          {videoError}
        </div>
      )}

      {/* Main Player + Optional Synced Transcript */}
      <div className={`grid gap-4 ${showTranscript ? 'lg:grid-cols-3' : ''}`}>
        <div className={showTranscript ? 'lg:col-span-2 space-y-3' : 'space-y-3'}>
          {!videoUrl ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              className={`rounded-2xl border-2 border-dashed p-12 text-center space-y-4 transition ${
                dragActive
                  ? 'border-torii bg-sun/20'
                  : 'border-line-2 bg-paper'
              }`}
            >
              <div className="text-4xl" aria-hidden="true">
                🎬
              </div>
              <div className="space-y-1">
                <div className="text-base font-semibold text-ink">
                  Drop a downloaded episode here
                </div>
                <p className="text-xs text-muted max-w-md mx-auto">
                  Plays 100% locally in your browser (nothing is uploaded). Supports MP4, WebM, and
                  browser-playable MKV files with instant untainted screenshot &amp; audio capture.
                </p>
              </div>
              <label className="btn btn-sun inline-block px-4 py-2 text-xs font-bold cursor-pointer">
                Choose Video File
                <input
                  type="file"
                  accept="video/*,.mkv,.mp4,.webm,.mov"
                  className="hidden"
                  onChange={(e) => loadLocalVideoFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
          ) : (
            <div
              ref={stageRef}
              className="relative bg-black rounded-2xl overflow-hidden border border-slate-800 select-none"
            >
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                playsInline
                onError={() =>
                  setVideoError(
                    `Your browser could not decode "${videoName}". Try MP4/WebM (H.264/VP9 + AAC/Opus) if an MKV audio track is unsupported.`,
                  )
                }
                className="w-full max-h-[68vh] bg-black block"
              />

              {/* Toast */}
              {toast && (
                <div className="absolute top-3 right-3 z-20 px-3 py-1.5 rounded-lg bg-slate-950/90 border border-sky-400/50 text-sky-200 text-xs font-semibold shadow-lg">
                  {toast}
                </div>
              )}

              {/* Hover/Click Dictionary Popup */}
              {popupToken && (
                <div className="absolute bottom-32 left-1/2 -translate-x-1/2 z-30 w-[min(360px,92%)] bg-slate-950/95 border border-slate-700 rounded-xl p-3.5 shadow-2xl text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="text-lg font-bold text-slate-50">{popupToken.lemma}</span>
                      {popupToken.lemma_reading && popupToken.lemma_reading !== popupToken.lemma && (
                        <span className="ml-2 text-xs text-sky-300">
                          {popupToken.lemma_reading}
                        </span>
                      )}
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                        {popupToken.is_proper_noun ? `${popupToken.pos} · Name` : popupToken.pos}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={closeTokenPopup}
                      className="text-xs text-slate-400 hover:text-slate-100 px-1.5 py-0.5 rounded bg-slate-900"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="mt-2 text-xs text-slate-200 space-y-1 max-h-28 overflow-y-auto">
                    {lookupQuery.isLoading ? (
                      <div className="text-slate-400">Looking up…</div>
                    ) : pickedSenses && pickedSenses.senses.length > 0 ? (
                      <ol className="list-decimal list-inside space-y-0.5">
                        {pickedSenses.senses.slice(0, 4).map((s, idx) => (
                          <li key={idx}>{s.glosses.join('; ')}</li>
                        ))}
                      </ol>
                    ) : (
                      <div className="text-slate-500">No dictionary entry found.</div>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {popupToken.word_id !== null && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            statusMutation.mutate({
                              wordId: popupToken.word_id!,
                              status: 'known',
                            })
                          }
                          className="flex-1 px-2 py-1 rounded-md text-xs font-semibold border border-emerald-500/60 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 cursor-pointer"
                        >
                          Known (K)
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            statusMutation.mutate({
                              wordId: popupToken.word_id!,
                              status: 'ignored',
                            })
                          }
                          className="flex-1 px-2 py-1 rounded-md text-xs font-semibold border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
                        >
                          Ignore (I)
                        </button>
                        <button
                          type="button"
                          disabled={capturing}
                          onClick={() => void handleSaveCardWithCapture(popupToken, popupLine)}
                          className="flex-1 px-2 py-1 rounded-md text-xs font-semibold border border-sky-400/60 bg-sky-500/20 text-sky-200 hover:bg-sky-500/30 disabled:opacity-50 cursor-pointer"
                        >
                          Save (S)
                        </button>
                      </>
                    )}
                    {llmConfigured && popupLine && (
                      <button
                        type="button"
                        onClick={() => setExplainLine(popupLine)}
                        className="px-2 py-1 rounded-md text-xs font-semibold border border-indigo-400/50 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25 cursor-pointer"
                      >
                        Explain (E)
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Interactive Subtitle Overlay */}
              {activeLines.length > 0 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex flex-col items-center px-4">
                  <div className="pointer-events-auto max-w-[90%] rounded-xl bg-slate-950/85 px-4 py-2 text-center shadow-xl border border-slate-800/70 space-y-1.5">
                    {activeLines.map((line) => {
                      const highlighted = rankPlayerHighlightIndices(line.tokens, 3);
                      const romajiText = showRomaji ? getTranscriptLineRomaji(line) : '';
                      const showTrans =
                        translationMode !== 'off' || revealedLineId === line.id;
                      const transText = showTrans
                        ? translationMode === 'de' || (translationMode === 'off' && glossLang === 'ger')
                          ? (line.translation_de ?? line.translation_en)
                          : (line.translation_en ?? line.translation_de)
                        : null;

                      return (
                        <div key={line.id} className="space-y-0.5">
                          <div className="text-xl sm:text-2xl leading-relaxed text-slate-50 font-medium">
                            {line.tokens.map((tok, idx) => {
                              const lookupable = isTokenLookupable(tok);
                              const isHighlighted = highlighted.has(idx);
                              const isLearning = !tok.is_proper_noun && tok.status === 'learning';
                              return (
                                <span
                                  key={idx}
                                  onClick={lookupable ? () => openTokenPopup(tok, line) : undefined}
                                  onMouseEnter={
                                    lookupable && pauseOnHover
                                      ? () => openTokenPopup(tok, line)
                                      : undefined
                                  }
                                  className={`inline-block px-0.5 rounded transition ${
                                    lookupable ? 'cursor-pointer hover:bg-sky-400/25' : ''
                                  } ${
                                    isHighlighted
                                      ? 'border-b-2 border-sky-400 text-sky-100'
                                      : isLearning
                                        ? 'border-b-2 border-dotted border-amber-400'
                                        : ''
                                  }`}
                                >
                                  {tok.furigana.length > 0
                                    ? tok.furigana.map((seg, sIdx) =>
                                        shouldShowFurigana(tok, seg.ruby) ? (
                                          <ruby key={sIdx}>
                                            {seg.text}
                                            <rt className="text-[0.55em] text-slate-300">
                                              {seg.ruby}
                                            </rt>
                                          </ruby>
                                        ) : (
                                          <span key={sIdx}>{seg.text}</span>
                                        ),
                                      )
                                    : tok.surface}
                                </span>
                              );
                            })}
                          </div>
                          {romajiText && (
                            <div className="text-xs text-slate-400 tracking-wide">{romajiText}</div>
                          )}
                          {transText && (
                            <div className="text-xs text-sky-200/90 italic">{transText}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Controls Toolbar */}
          <div className="card p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => shiftOffset(-PLAYER_OFFSET_STEP_MS)}
                className="btn px-2 py-1 text-ink cursor-pointer"
                title="Shift subtitles earlier ([)"
              >
                −100ms
              </button>
              <button
                type="button"
                onClick={syncLineNow}
                className="btn px-2 py-1 text-torii-ink cursor-pointer"
                title="Sync nearest line to current playback time (\)"
              >
                Sync ({formatOffsetLabel(activeOffsetMs)}
                {syncPoints.length > 0
                  ? ` · ${syncPoints.length} pt${syncPoints.length === 1 ? '' : 's'}`
                  : ''}
                )
              </button>
              <button
                type="button"
                onClick={() => shiftOffset(PLAYER_OFFSET_STEP_MS)}
                className="btn px-2 py-1 text-ink cursor-pointer"
                title="Shift subtitles later (])"
              >
                +100ms
              </button>
              <button
                type="button"
                onClick={() => replayLine(false)}
                className="btn px-2 py-1 text-ink cursor-pointer"
                title="Replay line (R)"
              >
                Replay (R)
              </button>
              <button
                type="button"
                onClick={() => replayLine(true)}
                className="btn px-2 py-1 text-ink cursor-pointer"
                title="Slow replay 0.75× (Shift+R)"
              >
                0.75×
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-ink-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pauseOnHover}
                  onChange={(e) => setPauseOnHover(e.target.checked)}
                />
                Pause on hover
              </label>
              <label className="flex items-center gap-1 text-ink-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoPause}
                  onChange={(e) => setAutoPause(e.target.checked)}
                />
                Auto-pause
              </label>
              <label className="flex items-center gap-1 text-ink-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showRomaji}
                  onChange={(e) => setShowRomaji(e.target.checked)}
                />
                Romaji
              </label>
              <select
                aria-label="Dictionary gloss language"
                value={glossLang}
                onChange={(e) => setGlossLang(e.target.value as GlossLanguage)}
                className="field px-1.5 py-1 text-ink"
              >
                <option value="eng">Dict EN</option>
                <option value="ger">Dict DE</option>
              </select>
              <select
                aria-label="Subtitle translation mode"
                value={translationMode}
                disabled={!llmConfigured}
                title={
                  llmConfigured
                    ? 'Show line translations (or press T to peek)'
                    : 'Configure an LLM on the server to enable translations'
                }
                onChange={(e) => setTranslationMode(e.target.value as TranslationMode)}
                className="field px-1.5 py-1 text-ink disabled:opacity-40"
              >
                <option value="off">Trans: Off</option>
                <option value="en">Trans: EN</option>
                <option value="de">Trans: DE</option>
              </select>
              {videoUrl && (
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  className="btn px-2 py-1 text-ink cursor-pointer"
                >
                  Fullscreen
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowTranscript((v) => !v)}
                className="btn px-2 py-1 text-ink cursor-pointer"
              >
                {showTranscript ? 'Hide Lines' : 'Show Lines'}
              </button>
              {activeEpisodeId !== null && (
                <button
                  type="button"
                  onClick={() => setShowMissed((v) => !v)}
                  className="btn btn-gold px-2 py-1 cursor-pointer font-semibold"
                >
                  Missed Words
                </button>
              )}
            </div>
          </div>

          {/* Explain Grammar Panel */}
          {explainLine && (
            <section className="bg-paper border border-plum/60 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-plum-ink uppercase tracking-wider">
                    Grammar Explanation
                  </div>
                  <div className="text-sm font-medium text-ink mt-0.5">
                    {explainLine.text}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setExplainLine(null)}
                  className="btn text-xs px-2 py-1 text-ink-2"
                >
                  Close
                </button>
              </div>
              {explainQuery.isLoading ? (
                <div className="text-xs text-muted">Explaining line…</div>
              ) : explainQuery.isError ? (
                <div className="text-xs text-rose-ink">
                  {(explainQuery.error as Error)?.message ?? 'Could not explain line.'}
                </div>
              ) : explainQuery.data ? (
                <MarkdownContent text={explainQuery.data.text} />
              ) : null}
            </section>
          )}

          {/* Post-Watch Missed Words Panel */}
          {showMissed && activeEpisodeId !== null && (
            <MissedWordsPanel
              episodeId={activeEpisodeId}
              glossLang={glossLang}
              onClose={() => setShowMissed(false)}
            />
          )}
        </div>

        {/* Synced Transcript Sidebar */}
        {showTranscript && (
          <aside className="card p-3 flex flex-col max-h-[76vh]">
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-line text-xs">
              <span className="font-semibold text-ink">
                Transcript ({lines.length} lines)
              </span>
              <span className="text-faint">Click line to seek</span>
            </div>
            <div className="overflow-y-auto space-y-1 flex-1 pr-1">
              {lines.map((line) => {
                const isActive = activeIdSet.has(line.id);
                const lineOffsetMs = resolvePlayerOffsetForLine(line, subOffsetMs, syncPoints);
                return (
                  <button
                    key={line.id}
                    type="button"
                    onClick={() => {
                      const video = videoRef.current;
                      if (!video) return;
                      skipAutoPauseOnceRef.current = true;
                      video.currentTime = computePlayerSeekSeconds(line, lineOffsetMs);
                    }}
                    className={`w-full text-left rounded-lg px-2.5 py-2 text-xs transition cursor-pointer ${
                      isActive
                        ? 'bg-sun/40 border border-torii/70 text-torii-ink'
                        : 'bg-field border border-transparent hover:bg-chip text-ink-2'
                    }`}
                  >
                    <div className="font-mono text-[10px] text-faint">
                      {formatTimestampMs(Math.max(0, line.start_ms + lineOffsetMs))}
                    </div>
                    <div className="mt-0.5 leading-snug">{line.text}</div>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
