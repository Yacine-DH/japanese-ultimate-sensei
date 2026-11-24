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
  onClose?: () => void;
}

type ImportTab = 'anki' | 'wordlist';

function ReportCard({ report }: { report: ImportReport }) {
  const [showUnmatched, setShowUnmatched] = useState(false);

  return (
    <div
      className={`rounded-xl border p-4 space-y-3 text-xs ${
        report.dry_run
          ? 'bg-sun/25 border-torii/70 text-ink'
          : 'bg-leaf/25 border-leaf/70 text-leaf-ink'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-sm">
          {report.dry_run ? 'Dry-run preview (nothing saved yet)' : 'Import complete'}
        </span>
        <span className="text-muted">{report.total.toLocaleString()} distinct entries</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="bg-field rounded-lg p-2.5 border border-line">
          <div className="text-[10px] uppercase text-muted">
            {report.dry_run ? 'Will update' : 'Updated'}
          </div>
          <div className="text-base font-bold text-leaf-ink">
            {report.updated.toLocaleString()}
          </div>
        </div>
        <div className="bg-field rounded-lg p-2.5 border border-line">
          <div className="text-[10px] uppercase text-muted">Matched</div>
          <div className="text-base font-bold text-torii-ink">{report.matched.toLocaleString()}</div>
        </div>
        <div className="bg-field rounded-lg p-2.5 border border-line">
          <div className="text-[10px] uppercase text-muted">Already set</div>
          <div className="text-base font-bold text-ink-2">
            {report.already.toLocaleString()}
          </div>
        </div>
        <div className="bg-field rounded-lg p-2.5 border border-line">
          <div className="text-[10px] uppercase text-muted">Skipped (new)</div>
          <div className="text-base font-bold text-muted">
            {report.skipped_new.toLocaleString()}
          </div>
        </div>
        <div className="bg-field rounded-lg p-2.5 border border-line">
          <div className="text-[10px] uppercase text-muted">Unmatched</div>
          <div className="text-base font-bold text-gold-ink">
            {report.unmatched_count.toLocaleString()}
          </div>
        </div>
      </div>

      {report.note_types.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] text-muted font-medium">Detected note types:</div>
          <div className="flex flex-wrap gap-1.5">
            {report.note_types.map((nt) => (
              <span
                key={nt.name}
                className="px-2 py-0.5 rounded bg-field border border-line text-ink-2"
              >
                {nt.name} ({nt.notes.toLocaleString()} notes · reading field{' '}
                <strong className="text-torii-ink">{nt.field_used || 'first'}</strong>)
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
            className="text-gold-ink hover:text-gold-ink underline underline-offset-2"
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
            <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-field border border-line p-2 flex flex-wrap gap-1.5">
              {report.unmatched.map((u, idx) => (
                <span
                  key={`${u}-${idx}`}
                  className="px-2 py-0.5 rounded bg-paper text-ink-2 border border-line"
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
    <section className="card p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Import Known Words</h2>
          <p className="text-xs text-muted">
            Seed your vocabulary from Anki or a plain list so episode highlights &amp; understanding %
            match what you already know. Statuses only move upward (ignored words stay untouched).
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="btn text-xs px-2.5 py-1 text-muted hover:text-ink transition"
          >
            Close
          </button>
        )}
      </div>

      {/* Mode tabs */}
      <div className="flex items-center gap-2 border-b border-line pb-3">
        <button
          type="button"
          onClick={() => setTab('anki')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
            tab === 'anki'
              ? 'bg-sun/40 border-torii/80 text-torii-ink'
              : 'bg-field border-line text-muted hover:text-ink'
          }`}
        >
          Anki Deck (.apkg)
        </button>
        <button
          type="button"
          onClick={() => setTab('wordlist')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
            tab === 'wordlist'
              ? 'bg-sun/40 border-torii/80 text-torii-ink'
              : 'bg-field border-line text-muted hover:text-ink'
          }`}
        >
          Plain Word List
        </button>
      </div>

      {tab === 'anki' ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="field inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold hover:border-torii/80 text-ink cursor-pointer transition">
              <span>{apkgFile ? apkgFile.name : 'Choose .apkg file…'}</span>
              <input
                type="file"
                accept=".apkg"
                className="hidden"
                onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
              />
            </label>
            <span className="text-xs text-faint">
              Tip: export from Anki with <em>Include media</em> unchecked for fast uploads.
            </span>
          </div>

          {apkgFile && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <label className="space-y-1">
                <span className="block text-muted">Japanese word field</span>
                {fieldInfo && fieldInfo.fields.length > 0 ? (
                  <select
                    value={selectedField}
                    onChange={(e) => setSelectedField(e.target.value)}
                    className="field w-full px-2.5 py-1.5 text-ink"
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
                    className="field w-full px-2.5 py-1.5 text-ink"
                  />
                )}
              </label>

              <label className="space-y-1">
                <span className="block text-muted">Deck filter</span>
                <select
                  value={selectedDeck}
                  onChange={(e) => setSelectedDeck(e.target.value)}
                  className="field w-full px-2.5 py-1.5 text-ink"
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
                <span className="block text-muted">Mature threshold (days → Known)</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={matureDays}
                  onChange={(e) => setMatureDays(Math.max(1, Math.min(365, Number(e.target.value) || 21)))}
                  className="field w-full px-2.5 py-1.5 text-ink"
                />
              </label>
            </div>
          )}

          {ankiError && (
            <div className="rounded-lg bg-rose/25 border border-rose/90 px-3 py-2 text-xs text-rose-ink">
              {ankiError}
            </div>
          )}

          {ankiMutation.isPending && (
            <div className="text-xs text-torii-ink animate-pulse">
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
                className="btn px-3.5 py-2 text-xs font-semibold text-ink disabled:opacity-50 transition"
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
                className="btn btn-leaf px-4 py-2 text-xs font-semibold disabled:opacity-50 transition"
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
              <span className="text-muted">
                Paste one Japanese word per line (HTML and <code>食[た]べる</code> furigana are
                cleaned automatically).
              </span>
              <span className="text-faint">{lineCount.toLocaleString()} lines</span>
            </div>
            <textarea
              rows={6}
              value={wordListText}
              onChange={(e) => {
                setWordListText(e.target.value);
                setListReport(null);
              }}
              placeholder={'食べる\n海賊\n大丈夫\nありがとう'}
              className="field w-full p-3 text-sm font-mono text-ink"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted">Mark as:</span>
              {(['known', 'learning'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setWordListStatus(st)}
                  className={`px-3 py-1 rounded-lg font-semibold border transition ${
                    wordListStatus === st
                      ? st === 'known'
                        ? 'bg-leaf/40 border-leaf/80 text-leaf-ink'
                        : 'bg-gold/40 border-gold/80 text-gold-ink'
                      : 'bg-field border-line text-muted hover:text-ink'
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
                className="btn px-3.5 py-2 text-xs font-semibold text-ink disabled:opacity-50 transition"
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
                className="btn btn-leaf px-4 py-2 text-xs font-semibold disabled:opacity-50 transition"
              >
                Import {lineCount > 0 ? `${lineCount.toLocaleString()} lines` : 'words'}
              </button>
            </div>
          </div>

          {listError && (
            <div className="rounded-lg bg-rose/25 border border-rose/90 px-3 py-2 text-xs text-rose-ink">
              {listError}
            </div>
          )}

          {listReport && <ReportCard report={listReport} />}
        </div>
      )}
    </section>
  );
}
