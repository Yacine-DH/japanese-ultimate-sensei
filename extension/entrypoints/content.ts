import { api, type LineOut } from '../src/api/client';
import { buildLineRomaji, renderTokenSegments } from '../src/lib/furigana';
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
    let toastEl: HTMLDivElement | null = null;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;

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
            background: rgba(10, 15, 28, 0.78);
            color: #f8fafc;
            padding: 8px 18px 10px;
            border-radius: 10px;
            text-align: center;
            line-height: 1.55;
            font-size: clamp(18px, 2.4vw, 30px);
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9);
            pointer-events: auto;
            user-select: text;
          }
          .sensei-sub-box:empty {
            display: none;
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
        `;

        const root = document.createElement('div');
        root.className = 'sensei-overlay-root';

        toastEl = document.createElement('div');
        toastEl.className = 'sensei-toast';

        subBoxEl = document.createElement('div');
        subBoxEl.className = 'sensei-sub-box';

        root.appendChild(toastEl);
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

    function renderLine(line: LineOut | null): void {
      if (!subBoxEl || !settings) return;
      if (!line) {
        subBoxEl.innerHTML = '';
        renderedLineId = null;
        return;
      }

      subBoxEl.innerHTML = '';
      renderedLineId = line.id;

      const jpLine = document.createElement('div');
      jpLine.className = 'sensei-jp-line';

      for (const token of line.tokens) {
        const span = document.createElement('span');
        span.className = 'sensei-token';
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
        jpLine.appendChild(span);
      }

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
