import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, type ImportReport, SenseiApiError } from '../api/client';
import {
  collectFieldOptions,
  countNonEmptyLines,
  formatDeckDisplayName,
  summarizeImportReport,
} from '../lib/import-words';

interface ImportWordsPanelProps {
  onImported: (summary: string) => void;
  onClose: () => void;
}

type ImportTab = 'anki' | 'wordlist';

function ReportCard({ report }: { report: ImportReport }) {
  const [showUnmatched, setShowUnmatched] = useState(false);

  return (
    <div
      className={`rounded-xl border p-4 space-y-3 text-xs ${
        report.dry_run
          ? 'bg-sky-950/30 border-sky-700/50 text-slate-200'
          : 'bg-emerald-950/30 border-emerald-700/50 text-emerald-100'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-sm">
          {report.dry_run ? 'Dry-run preview (nothing saved yet)' : 'Import complete'}
        </span>
        <span className="text-slate-400">{report.total.toLocaleString()} distinct entries</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="bg-slate-950/70 rounded-lg p-2.5 border border-slate-800">
          <div className="text-[10px] uppercase text-slate-400">
            {report.dry_run ? 'Will update' : 'Updated'}
          </div>
          <div className="text-base font-bold text-emerald-300">
            {report.updated.toLocaleString()}
          </div>
        </div>
        <div className="bg-slate-950/70 rounded-lg p-2.5 border border-slate-800">
          <div className="text-[10px] uppercase text-slate-400">Matched</div>
          <div className="text-base font-bold text-sky-300">{report.matched.toLocaleString()}</div>
        </div>
        <div className="bg-slate-950/70 rounded-lg p-2.5 border border-slate-800">
          <div className="text-[10px] uppercase text-slate-400">Already set</div>
          <div className="text-base font-bold text-slate-300">
            {report.already.toLocaleString()}
          </div>
        </div>
        <div className="bg-slate-950/70 rounded-lg p-2.5 border border-slate-800">
          <div className="text-[10px] uppercase text-slate-400">Skipped (new)</div>
          <div className="text-base font-bold text-slate-400">
            {report.skipped_new.toLocaleString()}
          </div>
        </div>
        <div className="bg-slate-950/70 rounded-lg p-2.5 border border-slate-800">
          <div className="text-[10px] uppercase text-slate-400">Unmatched</div>
          <div className="text-base font-bold text-amber-300">
            {report.unmatched_count.toLocaleString()}
          </div>
        </div>
      </div>

      {report.note_types.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] text-slate-400 font-medium">Detected note types:</div>
          <div className="flex flex-wrap gap-1.5">
            {report.note_types.map((nt) => (
              <span
                key={nt.name}
                className="px-2 py-0.5 rounded bg-slate-950/80 border border-slate-800 text-slate-300"
              >
                {nt.name} ({nt.notes.toLocaleString()} notes · reading field{' '}
                <strong className="text-sky-300">{nt.field_used || 'first'}</strong>)
              </span>
            ))}
          </div>
        </div>
      )}

      {report.unmatched_count > 0 && report.unmatched.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowUnmatched((v) => !v)}
            className="text-amber-300 hover:text-amber-200 underline underline-offset-2"
          >
            {showUnmatched
              ? 'Hide unmatched entries'
              : `Inspect unmatched entries (${report.unmatched.length}${
                  report.unmatched_count > report.unmatched.length
                    ? ` of ${report.unmatched_count}`
                    : ''
                })`}
          </button>
          {showUnmatched && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-slate-950/80 border border-slate-800 p-2 flex flex-wrap gap-1.5">
              {report.unmatched.map((u, idx) => (
                <span
                  key={`${u}-${idx}`}
                  className="px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800"
                >
                  {u}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ImportWordsPanel({ onImported, onClose }: ImportWordsPanelProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ImportTab>('anki');

  // Anki .apkg state
  const [apkgFile, setApkgFile] = useState<File | null>(null);
  const [selectedField, setSelectedField] = useState('');
  const [selectedDeck, setSelectedDeck] = useState('');
  const [matureDays, setMatureDays] = useState(21);
  const [ankiReport, setAnkiReport] = useState<ImportReport | null>(null);
  const [ankiError, setAnkiError] = useState<string | null>(null);

  // Word list state
  const [wordListText, setWordListText] = useState('');
  const [wordListStatus, setWordListStatus] = useState<'known' | 'learning'>('known');
  const [listReport, setListReport] = useState<ImportReport | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  function invalidateVocabCaches(): void {
    void queryClient.invalidateQueries({ queryKey: ['words'] });
    void queryClient.invalidateQueries({ queryKey: ['episodes'] });
    void queryClient.invalidateQueries({ queryKey: ['understanding'] });
    void queryClient.invalidateQueries({ queryKey: ['anime-list'] });
    void queryClient.invalidateQueries({ queryKey: ['anime-progress'] });
  }

  const ankiMutation = useMutation({
    mutationFn: (vars: {
      file: File;
      field: string;
      deck: string;
      matureDays: number;
      dryRun: boolean;
    }) =>
      apiClient.importAnkiApkg({
        file: vars.file,
        field: vars.field || undefined,
        deck: vars.deck || undefined,
        matureDays: vars.matureDays,
        dryRun: vars.dryRun,
      }),
    onSuccess: (report, vars) => {
      setAnkiError(null);
      setAnkiReport(report);
      if (vars.dryRun && !vars.field) {
        const info = collectFieldOptions(report.note_types);
        if (info.defaultField) {
          setSelectedField(info.defaultField);
        }
      }
      if (!vars.dryRun) {
        invalidateVocabCaches();
        onImported(summarizeImportReport(report));
      }
    },
    onError: (err) => {
      setAnkiError(
        err instanceof SenseiApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Anki import failed',
      );
    },
  });

  const wordListMutation = useMutation({
    mutationFn: (vars: { text: string; status: 'known' | 'learning'; dryRun: boolean }) =>
      apiClient.importWordList({
        text: vars.text,
        status: vars.status,
        dry_run: vars.dryRun,
      }),
    onSuccess: (report, vars) => {
      setListError(null);
      setListReport(report);
      if (!vars.dryRun) {
        invalidateVocabCaches();
        onImported(summarizeImportReport(report));
      }
    },
    onError: (err) => {
      setListError(
        err instanceof SenseiApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Word list import failed',
      );
    },
  });

  const fieldInfo = ankiReport ? collectFieldOptions(ankiReport.note_types) : null;
  const lineCount = countNonEmptyLines(wordListText);

  function handleFileSelected(file: File | null): void {
    setApkgFile(file);
    setAnkiReport(null);
    setAnkiError(null);
    setSelectedField('');
    setSelectedDeck('');
    if (file) {
      ankiMutation.mutate({
        file,
        field: '',
        deck: '',
        matureDays,
        dryRun: true,
      });
    }
  }

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Import Known Words</h2>
          <p className="text-xs text-slate-400">
            Seed your vocabulary from Anki or a plain list so episode highlights &amp; understanding %
            match what you already know. Statuses only move upward (ignored words stay untouched).
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2.5 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
        >
          Close
        </button>
      </div>

      {/* Mode tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        <button
          type="button"
          onClick={() => setTab('anki')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
            tab === 'anki'
              ? 'bg-sky-500/20 border-sky-400/60 text-sky-200'
              : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
          }`}
        >
          Anki Deck (.apkg)
        </button>
        <button
          type="button"
          onClick={() => setTab('wordlist')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
            tab === 'wordlist'
              ? 'bg-sky-500/20 border-sky-400/60 text-sky-200'
              : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
          }`}
        >
          Plain Word List
        </button>
      </div>

      {tab === 'anki' ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-950 border border-slate-700 hover:border-sky-400/60 text-slate-200 cursor-pointer transition">
              <span>{apkgFile ? apkgFile.name : 'Choose .apkg file…'}</span>
              <input
                type="file"
                accept=".apkg"
                className="hidden"
                onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
              />
            </label>
            <span className="text-xs text-slate-500">
              Tip: export from Anki with <em>Include media</em> unchecked for fast uploads.
            </span>
          </div>

          {apkgFile && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <label className="space-y-1">
                <span className="block text-slate-400">Japanese word field</span>
                {fieldInfo && fieldInfo.fields.length > 0 ? (
                  <select
                    value={selectedField}
                    onChange={(e) => setSelectedField(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
                  >
                    <option value="">Auto-detect</option>
                    {fieldInfo.fields.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={selectedField}
                    onChange={(e) => setSelectedField(e.target.value)}
                    placeholder="Auto (Vocab / Expression / Front)"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
                  />
                )}
              </label>

              <label className="space-y-1">
                <span className="block text-slate-400">Deck filter</span>
                <select
                  value={selectedDeck}
                  onChange={(e) => setSelectedDeck(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
                >
                  <option value="">All decks</option>
                  {(ankiReport?.decks ?? []).map((d) => (
                    <option key={d} value={d}>
                      {formatDeckDisplayName(d)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="block text-slate-400">Mature threshold (days → Known)</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={matureDays}
                  onChange={(e) => setMatureDays(Math.max(1, Math.min(365, Number(e.target.value) || 21)))}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
                />
              </label>
            </div>
          )}

          {ankiError && (
            <div className="rounded-lg bg-rose-950/50 border border-rose-800/70 px-3 py-2 text-xs text-rose-200">
              {ankiError}
            </div>
          )}

          {ankiMutation.isPending && (
            <div className="text-xs text-sky-300 animate-pulse">
              Analyzing Anki deck…
            </div>
          )}

          {ankiReport && <ReportCard report={ankiReport} />}

          {apkgFile && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={ankiMutation.isPending}
                onClick={() =>
                  ankiMutation.mutate({
                    file: apkgFile,
                    field: selectedField,
                    deck: selectedDeck,
                    matureDays,
                    dryRun: true,
                  })
                }
                className="px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-700 bg-slate-950 text-slate-200 hover:bg-slate-800 disabled:opacity-50 transition"
              >
                Re-run Preview
              </button>
              <button
                type="button"
                disabled={ankiMutation.isPending}
                onClick={() =>
                  ankiMutation.mutate({
                    file: apkgFile,
                    field: selectedField,
                    deck: selectedDeck,
                    matureDays,
                    dryRun: false,
                  })
                }
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition"
              >
                {ankiReport?.dry_run
                  ? `Confirm & Import ${ankiReport.updated.toLocaleString()} words`
                  : 'Import Deck'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-slate-400">
                Paste one Japanese word per line (HTML and <code>食[た]べる</code> furigana are
                cleaned automatically).
              </span>
              <span className="text-slate-500">{lineCount.toLocaleString()} lines</span>
            </div>
            <textarea
              rows={6}
              value={wordListText}
              onChange={(e) => {
                setWordListText(e.target.value);
                setListReport(null);
              }}
              placeholder={'食べる\n海賊\n大丈夫\nありがとう'}
              className="w-full rounded-xl bg-slate-950 border border-slate-700 focus:border-sky-400 outline-none p-3 text-sm font-mono text-slate-100"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400">Mark as:</span>
              {(['known', 'learning'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setWordListStatus(st)}
                  className={`px-3 py-1 rounded-lg font-semibold border transition ${
                    wordListStatus === st
                      ? st === 'known'
                        ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-200'
                        : 'bg-amber-500/20 border-amber-400/60 text-amber-200'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {st === 'known' ? 'Known' : 'Learning'}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={lineCount === 0 || wordListMutation.isPending}
                onClick={() =>
                  wordListMutation.mutate({
                    text: wordListText,
                    status: wordListStatus,
                    dryRun: true,
                  })
                }
                className="px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-700 bg-slate-950 text-slate-200 hover:bg-slate-800 disabled:opacity-50 transition"
              >
                Preview
              </button>
              <button
                type="button"
                disabled={lineCount === 0 || wordListMutation.isPending}
                onClick={() =>
                  wordListMutation.mutate({
                    text: wordListText,
                    status: wordListStatus,
                    dryRun: false,
                  })
                }
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition"
              >
                Import {lineCount > 0 ? `${lineCount.toLocaleString()} lines` : 'words'}
              </button>
            </div>
          </div>

          {listError && (
            <div className="rounded-lg bg-rose-950/50 border border-rose-800/70 px-3 py-2 text-xs text-rose-200">
              {listError}
            </div>
          )}

          {listReport && <ReportCard report={listReport} />}
        </div>
      )}
    </section>
  );
}
