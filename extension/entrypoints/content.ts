import {
  api,
  isTabStateChangedMessage,
  type LineOut,
  type LookupResult,
  type TokenOut,
  type WordStatus,
} from '../src/api/client';
import { getLineRomaji, renderTokenSegments } from '../src/lib/furigana';
import {
  isLookupableToken,
  rankHighlightedTokenIndices,
  selectSensesForLanguage,
  updateWordStatusInLines,
} from '../src/lib/highlight';
import { shouldLoadTranscriptForFrame } from '../src/lib/line-cache';
import {
  type ExtensionSettings,
  getSettings,
  saveSettings,
  SETTINGS_STORAGE_KEY,
} from '../src/lib/settings';
import {
  computeReplaySeekSeconds,
  createSlowReplayState,
  findLineToReplay,
  shouldAutoPauseAfterLine,
  shouldRestorePlaybackRate,
  SLOW_REPLAY_RATE,
  type SlowReplayState,
} from '../src/lib/replay';
import {
  adjustOffsetMs,
  computeSyncOffsetMs,
  findActiveLines,
  createDebouncer,
  findReferenceLineForSync,
  formatActiveLinesKey,
  OFFSET_STEP_MS,
} from '../src/lib/timing';
import { isEditableTarget, matchHotkey } from '../src/lib/hotkeys';
import {
  DEFAULT_HOVER_CONFIG,
  HoverIntentController,
  resolvePopupWordAction,
} from '../src/lib/hover-intent';
import {
  computeOverlayBounds,
  findBestVideoInDocument,
  resolveOverlayMountTarget,
} from '../src/lib/video';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  main() {
    let settings: ExtensionSettings | null = null;
    let currentEpisodeId: number | null = null;
    let loadedEpisodeId: number | null = null;
    let tabOverlayEnabled = false;
    let lines: LineOut[] = [];
    let subOffsetMs = 0;
    let currentVideo: HTMLVideoElement | null = null;
    let renderedLinesKey: string | null = null;
    let prevActiveLineIds: number[] = [];
    let slowReplayState: SlowReplayState | null = null;
    let skipAutoPauseOnce = false;
    let frameCallbackId: number | null = null;
    let frameLoopMode: 'rvfc' | 'raf' | null = null;
    let hostEl: HTMLDivElement | null = null;
    let shadowRoot: ShadowRoot | null = null;
    let subBoxEl: HTMLDivElement | null = null;
    let popupEl: HTMLDivElement | null = null;
    let toastEl: HTMLDivElement | null = null;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    let pausedByHover = false;
    let hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null;
    let activePopupToken: TokenOut | null = null;
    let activePopupLineId: number | null = null;
    let positionRafId: number | null = null;
    let videoResizeObserver: ResizeObserver | null = null;
    const lookupCache = new Map<string, LookupResult>();
    const hoverIntent = new HoverIntentController<TokenOut>(() => ({
      hoverDelayMs: settings?.hoverDelayMs ?? DEFAULT_HOVER_CONFIG.hoverDelayMs,
      pauseOnHover: settings?.pauseOnHover ?? DEFAULT_HOVER_CONFIG.pauseOnHover,
      requireShiftForHover:
        settings?.requireShiftForHover ?? DEFAULT_HOVER_CONFIG.requireShiftForHover,
    }));

    function ensureOverlayMounted(video: HTMLVideoElement): void {
      const container = resolveOverlayMountTarget(document, video);

      if (!hostEl) {
        hostEl = document.createElement('div');
        hostEl.id = 'sensei-subtitle-overlay-host';
        hostEl.style.cssText =
          'position:fixed;pointer-events:none;z-index:2147483646;left:0;top:0;width:0;height:0;';
        shadowRoot = hostEl.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
          .sensei-overlay-root {
            position: fixed;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-end;
            pointer-events: none;
            box-sizing: border-box;
            padding-bottom: 44px;
            font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif;
          }
          .sensei-toast {
            position: absolute;
            top: 16px;
            right: 16px;
            background: rgba(15, 23, 42, 0.88);
            color: #38bdf8;
            border: 1px solid rgba(56, 189, 248, 0.45);
            border-radius: 6px;
            padding: 4px 10px;
            font-size: 13px;
            font-weight: 600;
            opacity: 0;
            transition: opacity 0.15s ease;
          }
          .sensei-toast.visible {
            opacity: 1;
          }
          .sensei-sub-box {
            max-width: 86%;
            background: rgba(10, 15, 28, 0.82);
            color: #f8fafc;
            padding: 8px 18px 10px;
            border-radius: 10px;
            text-align: center;
            line-height: 1.65;
            font-size: clamp(18px, 2.4vw, 30px);
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9);
            pointer-events: auto;
            user-select: text;
          }
          .sensei-sub-box:empty {
            display: none;
          }
          .sensei-line-item + .sensei-line-item {
            margin-top: 6px;
            padding-top: 4px;
            border-top: 1px solid rgba(148, 163, 184, 0.22);
          }
          .sensei-token {
            padding: 1px 2px;
            border-radius: 4px;
            transition: background 0.12s ease;
          }
          .sensei-token.content {
            cursor: pointer;
          }
          .sensei-token.proper-noun {
            cursor: pointer;
            color: #e2e8f0;
          }
          .sensei-token.content:hover,
          .sensei-token.proper-noun:hover {
            background: rgba(56, 189, 248, 0.25);
          }
          .sensei-token.highlighted {
            border-bottom: 2px solid #38bdf8;
            color: #e0f2fe;
          }
          .sensei-token.learning {
            border-bottom: 2px dotted #f59e0b;
          }
          .sensei-jp-line ruby {
            ruby-position: over;
          }
          .sensei-jp-line rt {
            font-size: 0.52em;
            color: #cbd5e1;
            font-weight: 500;
          }
          .sensei-romaji-line {
            margin-top: 4px;
            font-size: 0.56em;
            color: #94a3b8;
            letter-spacing: 0.02em;
          }
          .sensei-hover-popup {
            display: none;
            width: 320px;
            max-width: 90vw;
            margin-bottom: 10px;
            background: rgba(15, 23, 42, 0.96);
            border: 1px solid #334155;
            border-radius: 10px;
            padding: 12px 14px;
            color: #f8fafc;
            box-shadow: 0 12px 28px rgba(0, 0, 0, 0.55);
            pointer-events: auto;
            text-align: left;
            font-size: 14px;
            line-height: 1.4;
          }
          .sensei-hover-popup.visible {
            display: block;
          }
          .sensei-popup-header {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 6px;
          }
          .sensei-popup-lemma {
            font-size: 18px;
            font-weight: 700;
            color: #f8fafc;
          }
          .sensei-popup-reading {
            font-size: 13px;
            color: #38bdf8;
            margin-left: 6px;
          }
          .sensei-popup-pos {
            font-size: 11px;
            color: #94a3b8;
            background: #1e293b;
            padding: 2px 6px;
            border-radius: 4px;
          }
          .sensei-popup-glosses {
            margin: 6px 0 10px;
            padding-left: 18px;
            color: #e2e8f0;
            font-size: 13px;
          }
          .sensei-popup-glosses li {
            margin-bottom: 3px;
          }
          .sensei-popup-actions {
            display: flex;
            gap: 6px;
          }
          .sensei-popup-actions button {
            flex: 1;
            padding: 5px 8px;
            border-radius: 6px;
            border: 1px solid #475569;
            background: #1e293b;
            color: #f8fafc;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
          }
          .sensei-popup-actions button.known {
            border-color: #22c55e;
            color: #86efac;
          }
          .sensei-popup-actions button.save {
            border-color: #38bdf8;
            color: #7dd3fc;
          }
          .sensei-popup-actions button:hover {
            background: #334155;
          }
        `;

        const root = document.createElement('div');
        root.className = 'sensei-overlay-root';

        toastEl = document.createElement('div');
        toastEl.className = 'sensei-toast';

        popupEl = document.createElement('div');
        popupEl.className = 'sensei-hover-popup';
        popupEl.addEventListener('mouseenter', cancelHoverClose);
        popupEl.addEventListener('mouseleave', scheduleHoverClose);

        subBoxEl = document.createElement('div');
        subBoxEl.className = 'sensei-sub-box';
        subBoxEl.addEventListener('mouseleave', scheduleHoverClose);

        root.appendChild(toastEl);
        root.appendChild(popupEl);
        root.appendChild(subBoxEl);
        shadowRoot.appendChild(style);
        shadowRoot.appendChild(root);
      }

      if (hostEl.parentElement !== container) {
        container.appendChild(hostEl);
      }

      updateOverlayPosition(video);
    }

    function updateOverlayPosition(video: HTMLVideoElement): void {
      if (!shadowRoot) return;
      const root = shadowRoot.querySelector('.sensei-overlay-root') as HTMLDivElement | null;
      if (!root) return;
      const fs = document.fullscreenElement;
      const fsRect =
        fs && fs.contains(video) ? fs.getBoundingClientRect() : null;
      const bounds = computeOverlayBounds(video.getBoundingClientRect(), fsRect);
      root.style.left = `${bounds.left}px`;
      root.style.top = `${bounds.top}px`;
      root.style.width = `${bounds.width}px`;
      root.style.height = `${bounds.height}px`;
    }

    function scheduleOverlayPositionUpdate(): void {
      if (!currentVideo || positionRafId !== null) return;
      positionRafId = window.requestAnimationFrame(() => {
        positionRafId = null;
        if (currentVideo) {
          ensureOverlayMounted(currentVideo);
        }
      });
    }

    function showToast(text: string): void {
      if (!toastEl) return;
      toastEl.textContent = text;
      toastEl.classList.add('visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl?.classList.remove('visible');
      }, 1600);
    }

    function pauseVideoOnHover(): void {
      if (settings && !settings.pauseOnHover) {
        return;
      }
      if (currentVideo && !currentVideo.paused) {
        currentVideo.pause();
        pausedByHover = true;
      }
    }

    function resumeVideoAfterHover(): void {
      if (currentVideo && pausedByHover) {
        pausedByHover = false;
        void currentVideo.play().catch(() => {
          // Ignore autoplay restriction errors
        });
      }
    }

    function closeHoverPopup(): void {
      hoverIntent.leave();
      cancelHoverClose();
      activePopupToken = null;
      popupEl?.classList.remove('visible');
      resumeVideoAfterHover();
    }

    function cancelHoverClose(): void {
      if (hoverLeaveTimer) {
        clearTimeout(hoverLeaveTimer);
        hoverLeaveTimer = null;
      }
    }

    function scheduleHoverClose(): void {
      cancelHoverClose();
      hoverLeaveTimer = setTimeout(() => {
        activePopupToken = null;
        popupEl?.classList.remove('visible');
        resumeVideoAfterHover();
      }, 180);
    }

    async function handleStatusChange(
      token: TokenOut,
      status: WordStatus,
      lineId: number | null = activePopupLineId,
    ): Promise<void> {
      if (token.word_id === null) {
        showToast(status === 'learning' ? 'Saved for review' : `Marked ${status}`);
        return;
      }
      if (status === 'learning') {
        const cardRes = await api.createCard({
          word_id: token.word_id,
          line_id: lineId,
          media_ids: [],
        });
        if (cardRes.ok) {
          lines = updateWordStatusInLines(lines, token.word_id, 'learning');
          renderedLinesKey = null;
          syncSubtitleFrame();
          showToast(
            cardRes.data?.created === false
              ? `Already in review: ${token.lemma}`
              : `Saved card: ${token.lemma}`,
          );
          return;
        }
      }
      const res = await api.setWordStatus(token.word_id, status);
      if (res.ok) {
        lines = updateWordStatusInLines(lines, token.word_id, status);
        renderedLinesKey = null;
        syncSubtitleFrame();
        showToast(
          status === 'known'
            ? `Known: ${token.lemma}`
            : status === 'ignored'
              ? `Ignored: ${token.lemma}`
              : `Saved: ${token.lemma}`,
        );
      } else {
        showToast(`Error: ${res.error ?? 'Failed to update word'}`);
      }
    }

    async function openHoverPopup(token: TokenOut, lineId: number | null = null): Promise<void> {
      if (!popupEl || !settings) return;
      cancelHoverClose();
      activePopupToken = token;
      activePopupLineId = lineId;
      pauseVideoOnHover();

      popupEl.innerHTML = '';
      popupEl.classList.add('visible');

      const header = document.createElement('div');
      header.className = 'sensei-popup-header';

      const titleWrap = document.createElement('div');
      const lemmaSpan = document.createElement('span');
      lemmaSpan.className = 'sensei-popup-lemma';
      lemmaSpan.textContent = token.lemma;
      titleWrap.appendChild(lemmaSpan);

      if (token.lemma_reading && token.lemma_reading !== token.lemma) {
        const readingSpan = document.createElement('span');
        readingSpan.className = 'sensei-popup-reading';
        readingSpan.textContent = token.lemma_reading;
        titleWrap.appendChild(readingSpan);
      }

      const posSpan = document.createElement('span');
      posSpan.className = 'sensei-popup-pos';
      posSpan.textContent = token.is_proper_noun ? `${token.pos} · Name` : token.pos;

      header.appendChild(titleWrap);
      header.appendChild(posSpan);
      popupEl.appendChild(header);

      const glossList = document.createElement('ol');
      glossList.className = 'sensei-popup-glosses';
      const loadingItem = document.createElement('li');
      loadingItem.textContent = 'Looking up...';
      glossList.appendChild(loadingItem);
      popupEl.appendChild(glossList);

      const actions = document.createElement('div');
      actions.className = 'sensei-popup-actions';

      const knownBtn = document.createElement('button');
      knownBtn.type = 'button';
      knownBtn.className = 'known';
      knownBtn.textContent = 'Known (K)';
      knownBtn.addEventListener('click', () => void handleStatusChange(token, 'known'));

      const ignoreBtn = document.createElement('button');
      ignoreBtn.type = 'button';
      ignoreBtn.textContent = 'Ignore (I)';
      ignoreBtn.addEventListener('click', () => void handleStatusChange(token, 'ignored'));

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'save';
      saveBtn.textContent = 'Save (S)';
      saveBtn.addEventListener('click', () => void handleStatusChange(token, 'learning'));

      actions.appendChild(knownBtn);
      actions.appendChild(ignoreBtn);
      actions.appendChild(saveBtn);
      popupEl.appendChild(actions);

      const cacheKey = `${token.lemma}:${token.lemma_reading}`;
      let lookup = lookupCache.get(cacheKey);
      if (!lookup) {
        const res = await api.lookupDictionary(token.lemma, token.lemma_reading, 3);
        if (res.ok && res.data) {
          lookup = res.data;
          lookupCache.set(cacheKey, lookup);
        } else {
          glossList.innerHTML = '';
          const errLi = document.createElement('li');
          errLi.textContent = res.error ?? 'Dictionary unavailable';
          glossList.appendChild(errLi);
          return;
        }
      }

      glossList.innerHTML = '';
      const topEntry = lookup.entries[0];
      if (!topEntry) {
        const emptyLi = document.createElement('li');
        emptyLi.textContent = 'No dictionary entry found';
        glossList.appendChild(emptyLi);
        return;
      }

      const { senses } = selectSensesForLanguage(topEntry, settings.glossLang);
      if (senses.length === 0) {
        const emptyLi = document.createElement('li');
        emptyLi.textContent = 'No glosses available';
        glossList.appendChild(emptyLi);
        return;
      }

      for (const sense of senses.slice(0, 4)) {
        const li = document.createElement('li');
        li.textContent = sense.glosses.join('; ');
        glossList.appendChild(li);
      }
    }

    function renderLines(activeLines: readonly LineOut[]): void {
      if (!subBoxEl || !settings) return;
      if (activeLines.length === 0) {
        subBoxEl.innerHTML = '';
        renderedLinesKey = '';
        return;
      }

      subBoxEl.innerHTML = '';
      renderedLinesKey = formatActiveLinesKey(activeLines);

      for (const line of activeLines) {
        const lineContainer = document.createElement('div');
        lineContainer.className = 'sensei-line-item';

        const highlightedIndices = rankHighlightedTokenIndices(
          line.tokens,
          settings.highlightLimit,
        );

        const jpLine = document.createElement('div');
        jpLine.className = 'sensei-jp-line';

        line.tokens.forEach((token, idx) => {
          const span = document.createElement('span');
          const classes = ['sensei-token'];
          if (token.is_proper_noun) {
            classes.push('proper-noun');
          } else if (token.is_content) {
            classes.push('content');
          }
          if (highlightedIndices.has(idx)) {
            classes.push('highlighted');
          } else if (!token.is_proper_noun && token.status === 'learning') {
            classes.push('learning');
          }
          span.className = classes.join(' ');

          const segments = renderTokenSegments(token);
          for (const seg of segments) {
            if (seg.ruby) {
              const ruby = document.createElement('ruby');
              ruby.appendChild(document.createTextNode(seg.text));
              const rt = document.createElement('rt');
              rt.textContent = seg.ruby;
              ruby.appendChild(rt);
              span.appendChild(ruby);
            } else {
              span.appendChild(document.createTextNode(seg.text));
            }
          }

          if (isLookupableToken(token)) {
            span.addEventListener('mouseenter', (ev) => {
              cancelHoverClose();
              hoverIntent.enter(token, ev.shiftKey, (t) => {
                void openHoverPopup(t, line.id);
              });
            });
            span.addEventListener('mouseleave', () => {
              hoverIntent.leave();
            });
          }

          jpLine.appendChild(span);
        });

        lineContainer.appendChild(jpLine);

        if (settings.romaji) {
          const romajiText = getLineRomaji(line);
          if (romajiText) {
            const romajiDiv = document.createElement('div');
            romajiDiv.className = 'sensei-romaji-line';
            romajiDiv.textContent = romajiText;
            lineContainer.appendChild(romajiDiv);
          }
        }

        subBoxEl.appendChild(lineContainer);
      }
    }

    function restoreSlowReplayIfNeeded(videoMs: number, force = false): void {
      if (!currentVideo || !slowReplayState) return;
      if (force || shouldRestorePlaybackRate(slowReplayState, videoMs)) {
        const rate = slowReplayState.originalRate;
        slowReplayState = null;
        currentVideo.playbackRate = rate;
      }
    }

    function replayCurrentOrLastLine(slow: boolean): void {
      if (!currentVideo || lines.length === 0) return;
      const videoMs = currentVideo.currentTime * 1000;
      const target = findLineToReplay(lines, videoMs, subOffsetMs);
      if (!target) {
        showToast('No line to replay');
        return;
      }

      if (slow) {
        const originalRate = slowReplayState?.originalRate ?? currentVideo.playbackRate;
        slowReplayState = createSlowReplayState(target, subOffsetMs, originalRate);
        currentVideo.playbackRate = SLOW_REPLAY_RATE;
        showToast(`Slow replay (${SLOW_REPLAY_RATE}×)`);
      } else {
        restoreSlowReplayIfNeeded(videoMs, true);
        showToast('Replay line');
      }

      skipAutoPauseOnce = true;
      currentVideo.currentTime = computeReplaySeekSeconds(target, subOffsetMs);
      pausedByHover = false;
      void currentVideo.play().catch(() => {
        // Ignore autoplay restrictions
      });
    }

    function syncSubtitleFrame(): void {
      if (!currentVideo || !tabOverlayEnabled || !currentEpisodeId || lines.length === 0) {
        if (renderedLinesKey !== null && renderedLinesKey !== '') {
          renderLines([]);
        }
        prevActiveLineIds = [];
        return;
      }
      ensureOverlayMounted(currentVideo);
      const videoMs = currentVideo.currentTime * 1000;
      restoreSlowReplayIfNeeded(videoMs);

      const active = findActiveLines(lines, videoMs, subOffsetMs);
      const activeIds = active.map((l) => l.id);

      if (
        !currentVideo.paused &&
        !skipAutoPauseOnce &&
        shouldAutoPauseAfterLine(
          prevActiveLineIds,
          activeIds,
          Boolean(settings?.autoPauseEachLine),
        )
      ) {
        currentVideo.pause();
        showToast('Paused at end of line (study mode)');
      }
      skipAutoPauseOnce = false;
      prevActiveLineIds = activeIds;

      const nextKey = formatActiveLinesKey(active);
      if (nextKey !== renderedLinesKey) {
        renderLines(active);
      }
    }

    function stopFrameLoop(): void {
      if (frameCallbackId === null) return;
      const v = currentVideo as (HTMLVideoElement & {
        cancelVideoFrameCallback?: (id: number) => void;
      }) | null;
      if (frameLoopMode === 'rvfc' && v?.cancelVideoFrameCallback) {
        v.cancelVideoFrameCallback(frameCallbackId);
      } else {
        window.cancelAnimationFrame(frameCallbackId);
      }
      frameCallbackId = null;
      frameLoopMode = null;
    }

    function startFrameLoop(): void {
      stopFrameLoop();
      if (!currentVideo || currentVideo.paused || currentVideo.ended) {
        return;
      }
      const v = currentVideo as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (typeof v.requestVideoFrameCallback === 'function') {
        frameLoopMode = 'rvfc';
        const tick = () => {
          frameCallbackId = null;
          syncSubtitleFrame();
          if (currentVideo && !currentVideo.paused && !currentVideo.ended) {
            frameCallbackId = v.requestVideoFrameCallback!(tick);
          }
        };
        frameCallbackId = v.requestVideoFrameCallback(tick);
      } else {
        frameLoopMode = 'raf';
        const tick = () => {
          frameCallbackId = null;
          syncSubtitleFrame();
          if (currentVideo && !currentVideo.paused && !currentVideo.ended) {
            frameCallbackId = window.requestAnimationFrame(tick);
          }
        };
        frameCallbackId = window.requestAnimationFrame(tick);
      }
    }

    async function maybeLoadTranscript(): Promise<void> {
      const shouldLoad = shouldLoadTranscriptForFrame({
        hasQualifyingVideo: currentVideo !== null,
        tabEnabled: tabOverlayEnabled,
        episodeId: currentEpisodeId,
      });

      if (!shouldLoad || currentEpisodeId === null) {
        lines = [];
        loadedEpisodeId = null;
        renderedLinesKey = null;
        renderLines([]);
        return;
      }

      if (loadedEpisodeId === currentEpisodeId && lines.length > 0) {
        renderedLinesKey = null;
        syncSubtitleFrame();
        return;
      }

      const targetId = currentEpisodeId;
      loadedEpisodeId = targetId;
      renderedLinesKey = null;

      const [epRes, linesRes] = await Promise.all([
        api.getEpisode(targetId),
        api.getEpisodeLines(targetId),
      ]);
      if (currentEpisodeId !== targetId) {
        return;
      }
      if (epRes.ok && epRes.data) {
        subOffsetMs = epRes.data.sub_offset_ms;
      }
      if (linesRes.ok && linesRes.data) {
        lines = linesRes.data;
      }
      syncSubtitleFrame();
      startFrameLoop();
    }

    function applyTabState(episodeId: number | null, enabled: boolean): void {
      currentEpisodeId = episodeId;
      tabOverlayEnabled = enabled && episodeId !== null;
      void maybeLoadTranscript();
    }

    function scanForVideo(): void {
      const best = findBestVideoInDocument(document);
      if (best && best !== currentVideo) {
        stopFrameLoop();
        if (videoResizeObserver) {
          videoResizeObserver.disconnect();
        }
        currentVideo = best;
        currentVideo.addEventListener('timeupdate', syncSubtitleFrame);
        currentVideo.addEventListener('seeked', syncSubtitleFrame);
        currentVideo.addEventListener('play', startFrameLoop);
        currentVideo.addEventListener('playing', startFrameLoop);
        currentVideo.addEventListener('pause', stopFrameLoop);
        currentVideo.addEventListener('ended', stopFrameLoop);
        if (typeof ResizeObserver !== 'undefined') {
          videoResizeObserver = new ResizeObserver(() => {
            scheduleOverlayPositionUpdate();
          });
          videoResizeObserver.observe(currentVideo);
        }
        ensureOverlayMounted(currentVideo);
        void maybeLoadTranscript();
        startFrameLoop();
      } else if (currentVideo) {
        updateOverlayPosition(currentVideo);
      }
    }

    const persistOffset = createDebouncer(400);

    // Capture phase so we run before the player's own key handlers; we stop the event
    // only when it matches one of our bindings (#4) or hovered-word shortcuts (#5).
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.isComposing || isEditableTarget(event.target)) {
          return;
        }
        if (
          !settings ||
          !currentVideo ||
          !tabOverlayEnabled ||
          !currentEpisodeId ||
          lines.length === 0
        ) {
          return;
        }

        // Yomitan-style Shift trigger while already resting on a content token (#5)
        if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
          hoverIntent.triggerWithShift((token) => {
            void openHoverPopup(token);
          });
          return;
        }

        // Keyboard actions on the currently open word popup: K (Known), I (Ignore), S (Save), Esc (Close)
        if (activePopupToken) {
          if (event.code === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            closeHoverPopup();
            return;
          }
          const wordStatus = resolvePopupWordAction(event);
          if (wordStatus) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            void handleStatusChange(activePopupToken, wordStatus);
            return;
          }
        }

        const action = matchHotkey(settings.hotkeys, event);
        if (!action) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (action === 'replayLine') {
          replayCurrentOrLastLine(false);
          return;
        }
        if (action === 'slowReplayLine') {
          replayCurrentOrLastLine(true);
          return;
        }
        if (action === 'toggleAutoPause') {
          const next = !settings.autoPauseEachLine;
          settings = { ...settings, autoPauseEachLine: next };
          void saveSettings({ autoPauseEachLine: next });
          showToast(`Study auto-pause: ${next ? 'ON' : 'OFF'}`);
          return;
        }

        if (action === 'offsetBack') {
          subOffsetMs = adjustOffsetMs(subOffsetMs, -OFFSET_STEP_MS);
        } else if (action === 'offsetForward') {
          subOffsetMs = adjustOffsetMs(subOffsetMs, OFFSET_STEP_MS);
        } else {
          const videoMs = currentVideo.currentTime * 1000;
          const refLine = findReferenceLineForSync(lines, videoMs, subOffsetMs);
          if (!refLine) return;
          subOffsetMs = computeSyncOffsetMs(videoMs, refLine);
        }

        const sign = subOffsetMs >= 0 ? '+' : '';
        showToast(`Sub offset: ${sign}${subOffsetMs} ms`);
        renderedLinesKey = null;
        syncSubtitleFrame();
        const episodeId = currentEpisodeId;
        const offset = subOffsetMs;
        persistOffset(() => {
          void api.patchEpisode(episodeId, { sub_offset_ms: offset });
        });
      },
      { capture: true },
    );

    document.addEventListener('fullscreenchange', () => {
      scheduleOverlayPositionUpdate();
    });

    window.addEventListener('resize', scheduleOverlayPositionUpdate, { passive: true });
    window.addEventListener('scroll', scheduleOverlayPositionUpdate, {
      capture: true,
      passive: true,
    });

    browser.runtime.onMessage.addListener((msg: unknown) => {
      if (isTabStateChangedMessage(msg)) {
        applyTabState(msg.state.episodeId, msg.state.enabled);
      }
    });

    browser.storage.onChanged.addListener((changes) => {
      if (changes[SETTINGS_STORAGE_KEY]) {
        void Promise.all([getSettings(), api.getTabState()]).then(([next, tabState]) => {
          settings = next;
          renderedLinesKey = null;
          applyTabState(tabState.episodeId, tabState.enabled);
        });
      }
    });

    void Promise.all([getSettings(), api.getTabState()]).then(([initial, tabState]) => {
      settings = initial;
      scanForVideo();
      applyTabState(tabState.episodeId, tabState.enabled);
      setInterval(scanForVideo, 1500);
    });
  },
});
