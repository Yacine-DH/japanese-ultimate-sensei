import {
  api,
  type LineOut,
  type LookupResult,
  type TokenOut,
  type WordStatus,
} from '../src/api/client';
import { buildLineRomaji, renderTokenSegments } from '../src/lib/furigana';
import {
  rankHighlightedTokenIndices,
  selectSensesForLanguage,
  updateWordStatusInLines,
} from '../src/lib/highlight';
import { type ExtensionSettings, getSettings, SETTINGS_STORAGE_KEY } from '../src/lib/settings';
import {
  adjustOffsetMs,
  computeSyncOffsetMs,
  findActiveLine,
  findReferenceLineForSync,
  resolveHotkeyAction,
} from '../src/lib/timing';
import { findBestVideoInDocument } from '../src/lib/video';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  main() {
    let settings: ExtensionSettings | null = null;
    let currentEpisodeId: number | null = null;
    let lines: LineOut[] = [];
    let subOffsetMs = 0;
    let currentVideo: HTMLVideoElement | null = null;
    let renderedLineId: number | null = null;
    let hostEl: HTMLDivElement | null = null;
    let shadowRoot: ShadowRoot | null = null;
    let subBoxEl: HTMLDivElement | null = null;
    let popupEl: HTMLDivElement | null = null;
    let toastEl: HTMLDivElement | null = null;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    let pausedByHover = false;
    let hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null;
    const lookupCache = new Map<string, LookupResult>();

    function ensureOverlayMounted(video: HTMLVideoElement): void {
      const fullscreenEl = document.fullscreenElement as HTMLElement | null;
      const container =
        fullscreenEl && fullscreenEl.contains(video)
          ? fullscreenEl
          : (video.parentElement ?? document.body);

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
          .sensei-token {
            padding: 1px 2px;
            border-radius: 4px;
            transition: background 0.12s ease;
          }
          .sensei-token.content {
            cursor: pointer;
          }
          .sensei-token.content:hover {
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
      const rect = video.getBoundingClientRect();
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
      root.style.width = `${rect.width}px`;
      root.style.height = `${rect.height}px`;
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

    function cancelHoverClose(): void {
      if (hoverLeaveTimer) {
        clearTimeout(hoverLeaveTimer);
        hoverLeaveTimer = null;
      }
    }

    function scheduleHoverClose(): void {
      cancelHoverClose();
      hoverLeaveTimer = setTimeout(() => {
        popupEl?.classList.remove('visible');
        resumeVideoAfterHover();
      }, 180);
    }

    async function handleStatusChange(token: TokenOut, status: WordStatus): Promise<void> {
      if (token.word_id === null) {
        showToast(status === 'learning' ? 'Saved for review' : `Marked ${status}`);
        return;
      }
      const res = await api.setWordStatus(token.word_id, status);
      if (res.ok) {
        lines = updateWordStatusInLines(lines, token.word_id, status);
        renderedLineId = null;
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

    async function openHoverPopup(token: TokenOut): Promise<void> {
      if (!popupEl || !settings) return;
      cancelHoverClose();
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
      posSpan.textContent = token.pos;

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
      knownBtn.textContent = 'Known';
      knownBtn.addEventListener('click', () => void handleStatusChange(token, 'known'));

      const ignoreBtn = document.createElement('button');
      ignoreBtn.type = 'button';
      ignoreBtn.textContent = 'Ignore';
      ignoreBtn.addEventListener('click', () => void handleStatusChange(token, 'ignored'));

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'save';
      saveBtn.textContent = 'Save';
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

    function renderLine(line: LineOut | null): void {
      if (!subBoxEl || !settings) return;
      if (!line) {
        subBoxEl.innerHTML = '';
        renderedLineId = null;
        return;
      }

      subBoxEl.innerHTML = '';
      renderedLineId = line.id;

      const highlightedIndices = rankHighlightedTokenIndices(
        line.tokens,
        settings.highlightLimit,
      );

      const jpLine = document.createElement('div');
      jpLine.className = 'sensei-jp-line';

      line.tokens.forEach((token, idx) => {
        const span = document.createElement('span');
        const classes = ['sensei-token'];
        if (token.is_content) {
          classes.push('content');
        }
        if (highlightedIndices.has(idx)) {
          classes.push('highlighted');
        } else if (token.status === 'learning') {
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

        if (token.is_content) {
          span.addEventListener('mouseenter', () => {
            void openHoverPopup(token);
          });
        }

        jpLine.appendChild(span);
      });

      subBoxEl.appendChild(jpLine);

      if (settings.romaji) {
        const romajiText = buildLineRomaji(line.tokens);
        if (romajiText) {
          const romajiDiv = document.createElement('div');
          romajiDiv.className = 'sensei-romaji-line';
          romajiDiv.textContent = romajiText;
          subBoxEl.appendChild(romajiDiv);
        }
      }
    }

    function syncSubtitleFrame(): void {
      if (!currentVideo || !settings?.activeEpisodeId || lines.length === 0) {
        if (renderedLineId !== null) {
          renderLine(null);
        }
        return;
      }
      ensureOverlayMounted(currentVideo);
      const videoMs = currentVideo.currentTime * 1000;
      const active = findActiveLine(lines, videoMs, subOffsetMs);
      if ((active?.id ?? null) !== renderedLineId) {
        renderLine(active);
      }
    }

    async function loadEpisodeData(episodeId: number | null): Promise<void> {
      currentEpisodeId = episodeId;
      renderedLineId = null;
      if (!episodeId) {
        lines = [];
        renderLine(null);
        return;
      }
      const [epRes, linesRes] = await Promise.all([
        api.getEpisode(episodeId),
        api.getEpisodeLines(episodeId),
      ]);
      if (epRes.ok && epRes.data) {
        subOffsetMs = epRes.data.sub_offset_ms;
      }
      if (linesRes.ok && linesRes.data) {
        lines = linesRes.data;
      }
      syncSubtitleFrame();
    }

    function scanForVideo(): void {
      const best = findBestVideoInDocument(document);
      if (best && best !== currentVideo) {
        currentVideo = best;
        currentVideo.addEventListener('timeupdate', syncSubtitleFrame);
        currentVideo.addEventListener('seeked', syncSubtitleFrame);
        ensureOverlayMounted(currentVideo);
        syncSubtitleFrame();
      } else if (currentVideo) {
        updateOverlayPosition(currentVideo);
      }
    }

    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!currentVideo || !currentEpisodeId || lines.length === 0) {
        return;
      }

      const action = resolveHotkeyAction(event.key);
      if (!action) return;

      if (action.type === 'step') {
        subOffsetMs = adjustOffsetMs(subOffsetMs, action.deltaMs);
      } else {
        const videoMs = currentVideo.currentTime * 1000;
        const refLine = findReferenceLineForSync(lines, videoMs, subOffsetMs);
        if (!refLine) return;
        subOffsetMs = computeSyncOffsetMs(videoMs, refLine);
      }

      const sign = subOffsetMs >= 0 ? '+' : '';
      showToast(`Sub offset: ${sign}${subOffsetMs} ms`);
      renderedLineId = null;
      syncSubtitleFrame();
      void api.patchEpisode(currentEpisodeId, { sub_offset_ms: subOffsetMs });
    });

    document.addEventListener('fullscreenchange', () => {
      if (currentVideo) {
        ensureOverlayMounted(currentVideo);
      }
    });

    window.addEventListener('resize', () => {
      if (currentVideo) {
        updateOverlayPosition(currentVideo);
      }
    });

    browser.storage.onChanged.addListener((changes) => {
      if (changes[SETTINGS_STORAGE_KEY]) {
        void getSettings().then((next) => {
          const prevEp = settings?.activeEpisodeId ?? null;
          settings = next;
          renderedLineId = null;
          if (next.activeEpisodeId !== prevEp) {
            void loadEpisodeData(next.activeEpisodeId);
          } else {
            syncSubtitleFrame();
          }
        });
      }
    });

    void getSettings().then((initial) => {
      settings = initial;
      scanForVideo();
      void loadEpisodeData(initial.activeEpisodeId);
      setInterval(scanForVideo, 1500);
    });
  },
});
