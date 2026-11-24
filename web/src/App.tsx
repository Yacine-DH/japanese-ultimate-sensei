import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IslandStage } from './components/IslandStage';
import { useIslandData } from './components/useIslandData';
import { loadIslandSettings, routeFor, saveIslandSettings, timeOfDay } from './lib/island';
import { EpisodeDetailPage } from './pages/EpisodeDetailPage';
import { HomePage } from './pages/HomePage';
import { KanaPage } from './pages/KanaPage';
import { LibraryPage } from './pages/LibraryPage';
import { PlayerPage } from './pages/PlayerPage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatsPage } from './pages/StatsPage';
import { WordsPage } from './pages/WordsPage';
import { emitIsland } from './scene/bus';

const queryClient = new QueryClient();

const navItems = [
  { to: '/', jp: '島', label: 'Home', end: true },
  { to: '/library', jp: '書庫', label: 'Library' },
  { to: '/review', jp: '道場', label: 'Review' },
  { to: '/words', jp: '言葉', label: 'Words' },
  { to: '/kana', jp: '仮名', label: 'Kana' },
  { to: '/stats', jp: '上達', label: 'Progress' },
  { to: '/player', jp: '映写', label: 'Player' },
  { to: '/settings', jp: '設定', label: 'Settings' },
];

/** Time of day: follows the clock until you move it; double-click goes back to the clock. */
function Sundial() {
  const [value, setValue] = useState(() => loadIslandSettings().time ?? timeOfDay(new Date()));
  return (
    <label
      className="sundial"
      title="Time of day on the island. Double-click to follow your clock again."
      onDoubleClick={() => {
        saveIslandSettings({ time: null });
        const now = timeOfDay(new Date());
        setValue(now);
        emitIsland({ type: 'time', value: now });
      }}
    >
      <span lang="ja">朝</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        aria-label="Time of day on the island"
        onChange={(e) => {
          const next = Number(e.target.value);
          setValue(next);
          saveIslandSettings({ time: next });
          emitIsland({ type: 'time', value: next });
        }}
      />
      <span lang="ja">夜</span>
    </label>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const route = routeFor(pathname);
  const island = useIslandData();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <>
      <IslandStage route={route} floors={island.floors} knownWords={island.knownWords} />
      <header className="topbar">
        <NavLink to="/" end className="brand" aria-label="Sensei Island, home">
          <span lang="ja">先生の島</span>
          <small>Sensei Island</small>
        </NavLink>
        <nav className="signpost" aria-label="Main">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              <span lang="ja">{item.jp}</span>
              <em>{item.label}</em>
              {item.to === '/review' && island.due > 0 && (
                <i className="due not-italic" aria-label={`${island.due} due`}>
                  {island.due > 99 ? '99+' : island.due}
                </i>
              )}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="page" data-layout={route.layout} data-page={route.page}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/episodes/:id" element={<EpisodeDetailPage />} />
          <Route path="/episodes/:id/watch" element={<PlayerPage />} />
          <Route path="/player" element={<PlayerPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/words" element={<WordsPage />} />
          <Route path="/kana" element={<KanaPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      {route.layout !== 'wide' && <Sundial />}
    </>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
