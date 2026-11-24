import { Link } from 'react-router-dom';
import { useIslandData } from '../components/useIslandData';
import { senseiGreeting } from '../lib/island';

/** The island itself: what the sensei says, what is due, and how the world has grown. */
export function HomePage() {
  const { state, due, streak, knownWords, understanding, animeCount } = useIslandData();
  const connected = state !== 'offline';
  const line = senseiGreeting({
    connected,
    due,
    streak: streak ?? 0,
    hour: new Date().getHours(),
  });

  return (
    <div className="home">
      <h1 className="sr-only">Sensei Island</h1>
      <section className="say" aria-label="Sensei says">
        <p className="jp" lang="ja">
          {line.jp.map(([text, reading], i) =>
            reading ? (
              <ruby key={i}>
                {text}
                <rt>{reading}</rt>
              </ruby>
            ) : (
              <span key={i}>{text}</span>
            ),
          )}
        </p>
        <p className="text-muted">{state === 'loading' ? 'One moment…' : line.en}</p>
        <div className="flex flex-wrap gap-2.5 pt-3.5">
          {connected ? (
            <>
              <Link to="/review" className="btn btn-sun px-4 py-2 font-bold">
                {due > 0 ? `Train: ${due} card${due === 1 ? '' : 's'}` : 'Open the dojo'}
              </Link>
              <Link to="/library" className="btn px-4 py-2 font-bold">
                Pick an episode
              </Link>
            </>
          ) : (
            <Link to="/settings" className="btn btn-sun px-4 py-2 font-bold">
              Connect in Settings
            </Link>
          )}
        </div>
      </section>

      {state === 'ready' && (
        <dl className="hud">
          <div>
            <dt>Blossoms</dt>
            <dd>{knownWords.toLocaleString('en')}</dd>
            <small>one per known word</small>
          </div>
          <div>
            <dt>Streak</dt>
            <dd>{streak ?? '—'}</dd>
            <small>{streak === 1 ? 'day' : 'days in a row'}</small>
          </div>
          <div>
            <dt>Understood</dt>
            <dd>{understanding === null ? '—' : `${Math.round(understanding)}%`}</dd>
            <small>
              {animeCount === 0 ? 'import an episode to start' : `across ${animeCount} anime`}
            </small>
          </div>
        </dl>
      )}
    </div>
  );
}
