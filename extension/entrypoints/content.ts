import {
  api,
  isOpenMissedPanelMessage,
  isTabStateChangedMessage,
  type LineOut,
  type LookupResult,
  type MissedWord,
  type TokenOut,
  type WatchIn,
  type WordStatus,
} from '../src/api/client';
import {
  bulkSaveMissedWords,
  formatMissedTimestamp,
  pickMissedGloss,
  shouldPromptMissedWordsPanel,
} from '../src/lib/missed';
import {
  WatchHeartbeatAccumulator,
  type WatchPlaybackSnapshot,
} from '../src/lib/watch-heartbeat';
import {
  captureVideoScreenshot,
  recordLineMedia,
  saveWordWithSceneCapture,
} from '../src/lib/capture';
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
    let missedPanelEl: HTMLDivElement | null = null;
    let missedPromptedEpisodeId: number | null = null;
    let toastEl: HTMLDivElement | null = null;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    let pausedByHover = false;
    let capturingScene = false;
    let isVideoBuffering = false;
    const watchHeartbeat = new WatchHeartbeatAccumulator();
    let hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null;
    let activePopupToken: TokenOut | null = null;
    let activePopupLine: LineOut | null = null;
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
            display: flex;
            align-items: center;
            gap: 10px;
            max-width: 300px;
            background: rgba(15, 23, 42, 0.92);
            color: #38bdf8;
            border: 1px solid rgba(56, 189, 248, 0.45);
            border-radius: 8px;
            padding: 6px 12px;
            font-size: 13px;
            font-weight: 600;
            opacity: 0;
            transition: opacity 0.15s ease;
          }
          .sensei-toast.visible {
            opacity: 1;
          }
          .sensei-toast-thumb {
            width: 56px;
            height: 34px;
            object-fit: cover;
            border-radius: 4px;
            border: 1px solid rgba(148, 163, 184, 0.35);
            flex-shrink: 0;
          }
          .sensei-toast-meta {
            display: block;
            font-size: 11px;
            font-weight: 500;
            color: #94a3b8;
            margin-top: 2px;
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
          .sensei-missed-panel {
            display: none;
            position: absolute;
            top: 20px;
            right: 20px;
            width: min(420px, calc(100% - 40px));
            max-height: calc(100% - 96px);
            background: rgba(15, 23, 42, 0.96);
            border: 1px solid #38bdf8;
            border-radius: 12px;
            padding: 14px 16px;
            color: #f8fafc;
            box-shadow: 0 18px 40px rgba(0, 0, 0, 0.7);
            pointer-events: auto;
            flex-direction: column;
            gap: 10px;
            font-size: 13px;
            text-align: left;
            z-index: 10;
          }
          .sensei-missed-panel.visible {
            display: flex;
          }
          .sensei-missed-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
          }
          .sensei-missed-title {
            font-size: 15px;
            font-weight: 700;
            color: #7dd3fc;
          }
          .sensei-missed-close {
            background: #1e293b;
            color: #cbd5e1;
            border: 1px solid #475569;
            border-radius: 6px;
            padding: 3px 8px;
            font-size: 11px;
            cursor: pointer;
          }
          .sensei-missed-list {
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 6px;
            max-height: 280px;
            padding-right: 4px;
          }
          .sensei-missed-row {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            background: #0f172a;
            border: 1px solid #334155;
            border-radius: 8px;
            padding: 7px 9px;
            cursor: pointer;
          }
          .sensei-missed-row input {
            margin-top: 3px;
            flex-shrink: 0;
          }
          .sensei-missed-word {
            font-weight: 700;
            color: #f8fafc;
            font-size: 14px;
          }
          .sensei-missed-reading {
            color: #38bdf8;
            font-size: 12px;
            margin-left: 5px;
          }
          .sensei-missed-meta {
            color: #94a3b8;
            font-size: 11px;
            margin-left: 6px;
          }
          .sensei-missed-gloss {
            color: #cbd5e1;
            font-size: 12px;
            margin-top: 2px;
          }
          .sensei-missed-example {
            color: #94a3b8;
            font-size: 11px;
            margin-top: 2px;
          }
          .sensei-missed-bar {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
          }
          .sensei-missed-bar button {
            padding: 5px 9px;
            border-radius: 6px;
            border: 1px solid #475569;
            background: #1e293b;
            color: #f8fafc;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
          }
          .sensei-missed-bar button.primary {
            background: #38bdf8;
            border-color: #38bdf8;
            color: #0f172a;
          }
          .sensei-missed-bar button.known {
            border-color: #22c55e;
            color: #86efac;
          }
          .sensei-missed-bar button:disabled {
            opacity: 0.45;
            cursor: not-allowed;
          }
        `;

        const root = document.createElement('div');
        root.className = 'sensei-overlay-root';

        toastEl = document.createElement('div');
        toastEl.className = 'sensei-toast';

        missedPanelEl = document.createElement('div');
        missedPanelEl.className = 'sensei-missed-panel';

        popupEl = document.createElement('div');
        popupEl.className = 'sensei-hover-popup';
        popupEl.addEventListener('mouseenter', cancelHoverClose);
        popupEl.addEventListener('mouseleave', scheduleHoverClose);

        subBoxEl = document.createElement('div');
        subBoxEl.className = 'sensei-sub-box';
        subBoxEl.addEventListener('mouseleave', scheduleHoverClose);

        root.appendChild(toastEl);
        root.appendChild(missedPanelEl);
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

    function showToast(text: string, durationMs = 1600): void {
      if (!toastEl) return;
      toastEl.innerHTML = '';
      toastEl.textContent = text;
      toastEl.classList.add('visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl?.classList.remove('visible');
      }, durationMs);
    }

    function showSavedToast(
      title: string,
      subtitle: string,
      thumbnailDataUrl: string | null,
    ): void {
      if (!toastEl) return;
      toastEl.innerHTML = '';
      if (thumbnailDataUrl) {
        const img = document.createElement('img');
        img.className = 'sensei-toast-thumb';
        img.src = thumbnailDataUrl;
        img.alt = title;
        toastEl.appendChild(img);
      }
      const wrap = document.createElement('div');
      const main = document.createElement('div');
      main.textContent = title;
      wrap.appendChild(main);
      if (subtitle) {
        const meta = document.createElement('span');
        meta.className = 'sensei-toast-meta';
        meta.textContent = subtitle;
        wrap.appendChild(meta);
      }
      toastEl.appendChild(wrap);
      toastEl.classList.add('visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl?.classList.remove('visible');
      }, 2800);
    }

    function pauseVideoOnHover(): void {
      if (capturingScene) return;
      if (settings && !settings.pauseOnHover) {
        return;
      }
      if (currentVideo && !currentVideo.paused) {
        currentVideo.pause();
        pausedByHover = true;
      }
    }

    function resumeVideoAfterHover(): void {
      if (capturingScene) return;
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
      line: LineOut | null = activePopupLine,
    ): Promise<void> {
      if (token.word_id === null) {
        showToast(status === 'learning' ? 'Saved for review' : `Marked ${status}`);
        return;
      }
      if (status === 'learning') {
        if (capturingScene) {
          showToast('Capture already in progress...');
          return;
        }
        const video = currentVideo;
        const wasPausedByHover = pausedByHover;
        showToast(`Capturing scene for ${token.lemma}...`, 15_000);

        const result = await saveWordWithSceneCapture({
          wordId: token.word_id,
          line,
          captureScreenshot: () =>
            video ? captureVideoScreenshot(video, () => api.captureVisibleTab()) : Promise.resolve(null),
          captureLineMedia: () =>
            video && line
              ? recordLineMedia(video, line, subOffsetMs, {
                  onStart: () => {
                    capturingScene = true;
                    skipAutoPauseOnce = true;
                    syncWatchHeartbeat();
                  },
                  onEnd: () => {
                    capturingScene = false;
                    // Don't double-pause if user already left popup while recording
                    if (wasPausedByHover && !activePopupToken && video.paused) {
                      pausedByHover = false;
                      void video.play().catch(() => {});
                    }
                    syncWatchHeartbeat();
                  },
                })
              : Promise.resolve({ audio: null, clip: null }),
          uploader: {
            uploadMedia: (m) => api.uploadMedia(m),
            createCard: (payload) => api.createCard(payload),
          },
        });

        if (result.cardRes.ok) {
          lines = updateWordStatusInLines(lines, token.word_id, 'learning');
          renderedLinesKey = null;
          syncSubtitleFrame();
          const title =
            result.cardRes.data?.created === false
              ? `Updated ✓ ${token.lemma}`
              : `Saved ✓ ${token.lemma}`;
          let detail =
            result.capturedKinds.length > 0
              ? `Attached: ${result.capturedKinds.join(', ')}`
              : 'Saved card to review queue';

          if (settings?.ankiConnectEnabled && result.cardRes.data?.id) {
            const ankiRes = await api.pushCardToAnki(result.cardRes.data.id);
            if (ankiRes.status === 'pushed') {
              detail += ' · Pushed to Anki';
            } else if (ankiRes.status === 'duplicate') {
              detail += ' · Already in Anki';
            } else if (ankiRes.status === 'queued') {
              detail += ' · Queued for Anki (offline)';
            }
          }

          showSavedToast(title, detail, result.thumbnailDataUrl);
        } else {
          showToast(`Error: ${result.cardRes.error ?? 'Failed to save card'}`);
        }
        return;
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

    async function openHoverPopup(token: TokenOut, line: LineOut | null = null): Promise<void> {
      if (!popupEl || !settings) return;
      cancelHoverClose();
      activePopupToken = token;
      activePopupLine = line;
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

      const cacheKey = `${token.word_id ?? ''}:${token.lemma}:${token.lemma_reading}`;
      let lookup = lookupCache.get(cacheKey);
      if (!lookup) {
        const res = await api.lookupDictionary(
          token.lemma,
          token.lemma_reading,
          3,
          token.word_id,
        );
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
                void openHoverPopup(t, line);
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

    function closeMissedWordsPanel(): void {
      missedPanelEl?.classList.remove('visible');
    }

    async function openMissedWordsPanel(episodeId: number): Promise<void> {
      if (!currentVideo || !settings) return;
      ensureOverlayMounted(currentVideo);
      if (!missedPanelEl) return;

      missedPromptedEpisodeId = episodeId;
      missedPanelEl.innerHTML = '';
      missedPanelEl.classList.add('visible');

      const header = document.createElement('div');
      header.className = 'sensei-missed-header';
      const title = document.createElement('div');
      title.className = 'sensei-missed-title';
      title.textContent = 'Words You Missed (Top Useful)';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'sensei-missed-close';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', closeMissedWordsPanel);
      header.appendChild(title);
      header.appendChild(closeBtn);
      missedPanelEl.appendChild(header);

      const statusLine = document.createElement('div');
      statusLine.style.fontSize = '12px';
      statusLine.style.color = '#94a3b8';
      statusLine.textContent = 'Loading ranked unknown words…';
      missedPanelEl.appendChild(statusLine);

      const res = await api.getEpisodeMissedWords(episodeId, 25, false);
      if (!res.ok || !res.data) {
        statusLine.textContent = res.error ?? 'Could not load missed words.';
        return;
      }

      let items: MissedWord[] = res.data;
      if (items.length === 0) {
        statusLine.textContent = 'Nice! No unknown words left in this episode.';
        return;
      }

      const selectedIds = new Set<number>(items.slice(0, 5).map((i) => i.word.id));
      const listEl = document.createElement('div');
      listEl.className = 'sensei-missed-list';
      const selectBar = document.createElement('div');
      selectBar.className = 'sensei-missed-bar';
      const actionBar = document.createElement('div');
      actionBar.className = 'sensei-missed-bar';

      const top5Btn = document.createElement('button');
      top5Btn.type = 'button';
      top5Btn.textContent = 'Top 5';
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.textContent = 'All';
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = 'Clear';
      selectBar.append(top5Btn, allBtn, clearBtn);

      const saveCardsBtn = document.createElement('button');
      saveCardsBtn.type = 'button';
      saveCardsBtn.className = 'primary';
      const markKnownBtn = document.createElement('button');
      markKnownBtn.type = 'button';
      markKnownBtn.className = 'known';
      const ignoreBtn = document.createElement('button');
      ignoreBtn.type = 'button';
      actionBar.append(saveCardsBtn, markKnownBtn, ignoreBtn);

      missedPanelEl.append(selectBar, listEl, actionBar);

      function updateButtons(): void {
        const count = selectedIds.size;
        saveCardsBtn.textContent = `Save Cards (${count})`;
        markKnownBtn.textContent = `Mark Known (${count})`;
        ignoreBtn.textContent = `Ignore (${count})`;
        saveCardsBtn.disabled = count === 0;
        markKnownBtn.disabled = count === 0;
        ignoreBtn.disabled = count === 0;
        statusLine.textContent = `${items.length} ranked unknown words · ${count} selected`;
      }

      function renderRows(): void {
        listEl.innerHTML = '';
        const lang = settings?.glossLang ?? 'eng';
        for (const item of items) {
          const row = document.createElement('label');
          row.className = 'sensei-missed-row';

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selectedIds.has(item.word.id);
          cb.addEventListener('change', () => {
            if (cb.checked) selectedIds.add(item.word.id);
            else selectedIds.delete(item.word.id);
            updateButtons();
          });

          const body = document.createElement('div');
          body.style.minWidth = '0';
          const top = document.createElement('div');
          const wordSpan = document.createElement('span');
          wordSpan.className = 'sensei-missed-word';
          wordSpan.textContent = item.word.lemma;
          top.appendChild(wordSpan);
          if (item.word.reading && item.word.reading !== item.word.lemma) {
            const readSpan = document.createElement('span');
            readSpan.className = 'sensei-missed-reading';
            readSpan.textContent = item.word.reading;
            top.appendChild(readSpan);
          }
          const metaSpan = document.createElement('span');
          metaSpan.className = 'sensei-missed-meta';
          metaSpan.textContent = `×${item.word.occurrences ?? 1} ep · ×${item.anime_occurrences} anime`;
          top.appendChild(metaSpan);
          body.appendChild(top);

          const gloss = pickMissedGloss(item, lang);
          if (gloss) {
            const glossEl = document.createElement('div');
            glossEl.className = 'sensei-missed-gloss';
            glossEl.textContent = gloss;
            body.appendChild(glossEl);
          }
          if (item.example) {
            const exEl = document.createElement('div');
            exEl.className = 'sensei-missed-example';
            exEl.textContent = `[${formatMissedTimestamp(item.example.start_ms)}] ${item.example.text}`;
            body.appendChild(exEl);
          }

          row.append(cb, body);
          listEl.appendChild(row);
        }
        updateButtons();
      }

      top5Btn.addEventListener('click', () => {
        selectedIds.clear();
        for (const item of items.slice(0, 5)) selectedIds.add(item.word.id);
        renderRows();
      });
      allBtn.addEventListener('click', () => {
        selectedIds.clear();
        for (const item of items) selectedIds.add(item.word.id);
        renderRows();
      });
      clearBtn.addEventListener('click', () => {
        selectedIds.clear();
        renderRows();
      });

      async function applyBulkStatus(status: WordStatus): Promise<void> {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        saveCardsBtn.disabled = markKnownBtn.disabled = ignoreBtn.disabled = true;
        const bulkRes = await api.bulkWordStatus(ids, status);
        if (bulkRes.ok) {
          for (const wid of ids) {
            lines = updateWordStatusInLines(lines, wid, status);
          }
          renderedLinesKey = null;
          syncSubtitleFrame();
          items = items.filter((i) => !selectedIds.has(i.word.id));
          selectedIds.clear();
          showToast(`Marked ${bulkRes.data?.updated ?? ids.length} words ${status}`);
          renderRows();
        } else {
          statusLine.textContent = bulkRes.error ?? 'Bulk update failed';
          updateButtons();
        }
      }

      saveCardsBtn.addEventListener('click', async () => {
        const chosen = items.filter((i) => selectedIds.has(i.word.id));
        if (chosen.length === 0) return;
        saveCardsBtn.disabled = markKnownBtn.disabled = ignoreBtn.disabled = true;
        statusLine.textContent = `Saving ${chosen.length} cards…`;
        const saveRes = await bulkSaveMissedWords(chosen, async (payload) => {
          const created = await api.createCard(payload);
          if (created.ok && created.data?.id && settings?.ankiConnectEnabled) {
            void api.pushCardToAnki(created.data.id);
          }
          return created;
        });
        for (const wid of saveRes.savedWordIds) {
          lines = updateWordStatusInLines(lines, wid, 'learning');
        }
        renderedLinesKey = null;
        syncSubtitleFrame();
        const savedSet = new Set(saveRes.savedWordIds);
        items = items.filter((i) => !savedSet.has(i.word.id));
        selectedIds.clear();
        showToast(
          `Saved ${saveRes.saved} new card${saveRes.saved === 1 ? '' : 's'}${saveRes.existing ? ` (${saveRes.existing} existing)` : ''}`,
        );
        renderRows();
      });

      markKnownBtn.addEventListener('click', () => void applyBulkStatus('known'));
      ignoreBtn.addEventListener('click', () => void applyBulkStatus('ignored'));

      renderRows();
    }

    function checkAutoOpenMissedPanel(ended = false): void {
      if (!currentVideo || !currentEpisodeId) return;
      if (
        shouldPromptMissedWordsPanel({
          currentTimeSec: currentVideo.currentTime,
          durationSec: currentVideo.duration,
          ended,
          alreadyPrompted: missedPromptedEpisodeId === currentEpisodeId,
          overlayEnabled: tabOverlayEnabled,
          episodeId: currentEpisodeId,
        })
      ) {
        void openMissedWordsPanel(currentEpisodeId);
      }
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
        !capturingScene &&
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
      checkAutoOpenMissedPanel(false);
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

    function dispatchWatchHeartbeat(payload: WatchIn | null): void {
      if (!payload) return;
      // Fire-and-forget through the background worker; silently drop offline errors (#65).
      void api.sendWatchHeartbeat(payload).catch(() => {});
    }

    function getWatchSnapshot(): WatchPlaybackSnapshot {
      const video = currentVideo;
      const isPlaying = Boolean(video && !video.paused && !video.ended && video.readyState >= 2);
      const isAudible = Boolean(video && !video.muted && video.volume > 0);
      const tabVisible = document.visibilityState !== 'hidden';
      return {
        episodeId: currentEpisodeId,
        overlayEnabled: tabOverlayEnabled,
        isPlaying,
        isBuffering: isVideoBuffering,
        isCapturing: capturingScene,
        tabVisible,
        isAudible,
      };
    }

    function syncWatchHeartbeat(nowMs = Date.now()): void {
      dispatchWatchHeartbeat(watchHeartbeat.update(getWatchSnapshot(), nowMs));
    }

    function flushWatchHeartbeat(nowMs = Date.now(), resetRemainder = false): void {
      dispatchWatchHeartbeat(watchHeartbeat.flush(nowMs, resetRemainder));
    }

    function handleVideoPlay(): void {
      isVideoBuffering = false;
      startFrameLoop();
      syncWatchHeartbeat();
    }

    function handleVideoPause(): void {
      isVideoBuffering = false;
      stopFrameLoop();
      syncWatchHeartbeat();
    }

    function handleVideoEnded(): void {
      handleVideoPause();
      checkAutoOpenMissedPanel(true);
    }

    function handleVideoBuffering(): void {
      isVideoBuffering = true;
      syncWatchHeartbeat();
    }

    function handleVideoVolumeChange(): void {
      syncWatchHeartbeat();
    }

    function applyTabState(episodeId: number | null, enabled: boolean): void {
      currentEpisodeId = episodeId;
      tabOverlayEnabled = enabled && episodeId !== null;
      syncWatchHeartbeat();
      void maybeLoadTranscript();
    }

    function scanForVideo(): void {
      const best = findBestVideoInDocument(document);
      if (best && best !== currentVideo) {
        if (currentVideo) {
          currentVideo.removeEventListener('timeupdate', syncSubtitleFrame);
          currentVideo.removeEventListener('seeked', syncSubtitleFrame);
          currentVideo.removeEventListener('play', handleVideoPlay);
          currentVideo.removeEventListener('playing', handleVideoPlay);
          currentVideo.removeEventListener('pause', handleVideoPause);
          currentVideo.removeEventListener('ended', handleVideoEnded);
          currentVideo.removeEventListener('waiting', handleVideoBuffering);
          currentVideo.removeEventListener('stalled', handleVideoBuffering);
          currentVideo.removeEventListener('volumechange', handleVideoVolumeChange);
          flushWatchHeartbeat(Date.now(), false);
        }
        stopFrameLoop();
        if (videoResizeObserver) {
          videoResizeObserver.disconnect();
        }
        isVideoBuffering = false;
        currentVideo = best;
        currentVideo.addEventListener('timeupdate', syncSubtitleFrame);
        currentVideo.addEventListener('seeked', syncSubtitleFrame);
        currentVideo.addEventListener('play', handleVideoPlay);
        currentVideo.addEventListener('playing', handleVideoPlay);
        currentVideo.addEventListener('pause', handleVideoPause);
        currentVideo.addEventListener('ended', handleVideoEnded);
        currentVideo.addEventListener('waiting', handleVideoBuffering);
        currentVideo.addEventListener('stalled', handleVideoBuffering);
        currentVideo.addEventListener('volumechange', handleVideoVolumeChange);
        if (typeof ResizeObserver !== 'undefined') {
          videoResizeObserver = new ResizeObserver(() => {
            scheduleOverlayPositionUpdate();
          });
          videoResizeObserver.observe(currentVideo);
        }
        ensureOverlayMounted(currentVideo);
        void maybeLoadTranscript();
        startFrameLoop();
        syncWatchHeartbeat();
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
    document.addEventListener('visibilitychange', () => {
      syncWatchHeartbeat();
    });
    window.addEventListener('pagehide', () => {
      flushWatchHeartbeat(Date.now(), true);
    });

    window.addEventListener('resize', scheduleOverlayPositionUpdate, { passive: true });
    window.addEventListener('scroll', scheduleOverlayPositionUpdate, {
      capture: true,
      passive: true,
    });

    browser.runtime.onMessage.addListener((msg: unknown) => {
      if (isTabStateChangedMessage(msg)) {
        if (msg.state.episodeId !== currentEpisodeId) {
          missedPromptedEpisodeId = null;
          closeMissedWordsPanel();
        }
        applyTabState(msg.state.episodeId, msg.state.enabled);
      } else if (isOpenMissedPanelMessage(msg)) {
        if (currentVideo && currentEpisodeId !== null) {
          void openMissedWordsPanel(currentEpisodeId);
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: false });
      }
      return undefined;
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
      setInterval(() => {
        if (currentVideo) {
          dispatchWatchHeartbeat(watchHeartbeat.tick(Date.now()));
        }
      }, 5000);
    });
  },
});
