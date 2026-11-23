import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LibraryPage } from './pages/LibraryPage';
import { EpisodeDetailPage } from './pages/EpisodeDetailPage';
import { ReviewPage } from './pages/ReviewPage';
import { WordsPage } from './pages/WordsPage';
import { KanaPage } from './pages/KanaPage';
import { PlayerPage } from './pages/PlayerPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';

const queryClient = new QueryClient();

const navItems = [
  { to: '/', label: 'Library', end: true },
  { to: '/player', label: 'Player' },
  { to: '/review', label: 'Review' },
  { to: '/words', label: 'Words' },
  { to: '/kana', label: 'Kana' },
  { to: '/stats', label: 'Stats' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col overflow-x-hidden">
          <header className="border-b border-slate-800 bg-slate-900/75 backdrop-blur sticky top-0 z-10">
            <div className="max-w-5xl mx-auto px-3 sm:px-4 py-2 sm:py-0 sm:h-14 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-2 shrink-0">
                <img
                  src="/favicon-32x32.png"
                  alt="Sensei"
                  width={24}
                  height={24}
                  className="w-6 h-6 rounded"
                />
                <span className="font-semibold text-slate-100 tracking-tight">Sensei</span>
              </div>
              <nav className="flex items-center gap-1 overflow-x-auto max-w-full pb-0.5 sm:pb-0">
                {navItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition whitespace-nowrap shrink-0 ${
                        isActive
                          ? 'bg-sky-400/15 text-sky-300'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </div>
          </header>
          <main className="flex-1 max-w-5xl w-full mx-auto px-3 sm:px-4 py-5 sm:py-8">
            <Routes>
              <Route path="/" element={<LibraryPage />} />
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
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
