import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  blossomCount,
  type IslandRoute,
  loadIslandSettings,
  type PagodaFloor,
  resolveCanvasResize,
  type SceneQuality,
  timeOfDay,
} from '../lib/island';
import { onIsland } from '../scene/bus';
import type { IslandHandle, PinId } from '../scene/island';

const PINS: ReadonlyArray<{ id: PinId; to: string; jp: string; en: string }> = [
  { id: 'library', to: '/library', jp: '書庫', en: 'Library' },
  { id: 'review', to: '/review', jp: '道場', en: 'Review' },
  { id: 'kana', to: '/kana', jp: '鐘', en: 'Kana' },
  { id: 'progress', to: '/stats', jp: '桜', en: 'Progress' },
];

export interface IslandStageProps {
  route: IslandRoute;
  floors: PagodaFloor[];
  knownWords: number;
}

/** Mounts the 3D island behind every page. three.js is loaded on demand, after the page works. */
export function IslandStage({ route, floors, knownWords }: IslandStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pinRefs = useRef<Partial<Record<PinId, HTMLAnchorElement | null>>>({});
  const handleRef = useRef<IslandHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [quality, setQuality] = useState<SceneQuality>(() => loadIslandSettings().quality);

  useEffect(
    () =>
      onIsland((e) => {
        if (e.type === 'quality') setQuality(loadIslandSettings().quality);
        else handleRef.current?.event(e);
      }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || quality === 'off') {
      setReady(false);
      return;
    }
    let cancelled = false;
    let cleanup = () => {};
    void import('../scene/island')
      .then(({ createIsland }) => {
        if (cancelled) return;
        const handle = createIsland(canvas, {
          light: quality === 'light',
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          onPins: (pins) => {
            for (const { id } of PINS) {
              const el = pinRefs.current[id];
              if (el) {
                el.style.transform = `translate(${pins[id].x.toFixed(1)}px,${pins[id].y.toFixed(1)}px) translate(-50%,-100%)`;
              }
            }
          },
        });
        handleRef.current = handle;
        const resize = () => {
          const size = resolveCanvasResize(canvas.clientWidth, canvas.clientHeight);
          if (size) handle.resize(size.width, size.height);
        };
        resize();
        addEventListener('resize', resize);
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
        ro?.observe(canvas);
        const followClock = () =>
          handle.setTime(loadIslandSettings().time ?? timeOfDay(new Date()));
        followClock();
        const clock = setInterval(followClock, 60_000);
        cleanup = () => {
          removeEventListener('resize', resize);
          ro?.disconnect();
          clearInterval(clock);
          handle.dispose();
          handleRef.current = null;
        };
        setReady(true);
      })
      .catch((err: unknown) => {
        // No WebGL: the painted sky background stays and every page still works.
        console.warn('Sensei Island could not start', err);
      });
    return () => {
      cancelled = true;
      cleanup();
      setReady(false);
    };
  }, [quality]);

  useEffect(() => {
    if (!ready) return;
    const dock = route.layout === 'dock' ? (route.page === 'stats' ? 680 : 580) : 0;
    handleRef.current?.setView(route.view, {
      dockWidth: dock,
      wide: route.layout === 'wide',
      hidden: route.hidden,
    });
    if (!route.hidden) {
      const canvas = canvasRef.current;
      const size = canvas
        ? resolveCanvasResize(canvas.clientWidth, canvas.clientHeight, route.hidden)
        : null;
      if (size) handleRef.current?.resize(size.width, size.height);
    }
  }, [ready, route.view, route.layout, route.page, route.hidden]);

  const floorsKey = floors.map((f) => f.animeId ?? '-').join(',');
  const blossoms = blossomCount(knownWords);
  useEffect(() => {
    if (ready) handleRef.current?.setData({ floors, blossoms });
    // floors is rebuilt on every render; its identity is the key
  }, [ready, floorsKey, blossoms]);

  return (
    <div
      className="island-stage"
      data-ready={ready}
      data-hidden={route.hidden}
      data-layout={route.layout}
    >
      {quality !== 'off' && <canvas key={quality} ref={canvasRef} aria-hidden="true" />}
      {ready && route.view === 'home' && (
        <nav aria-label="Places on the island">
          {PINS.map((p) => (
            <Link
              key={p.id}
              to={p.to}
              ref={(el) => {
                pinRefs.current[p.id] = el;
              }}
              className="pin"
              style={{ transform: 'translate(-200px,-200px)' }}
            >
              <span lang="ja">{p.jp}</span>
              <em className="not-italic">{p.en}</em>
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
