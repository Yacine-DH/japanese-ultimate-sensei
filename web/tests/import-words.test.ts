import { describe, expect, it } from 'vitest';
import type { AnkiNoteType, ImportReport } from '../src/api/client';
import {
  collectFieldOptions,
  countNonEmptyLines,
  formatDeckDisplayName,
  parseContentDispositionFilename,
  summarizeImportReport,
} from '../src/lib/import-words';

describe('import-words helpers', () => {
  it('collects unique fields across note types and selects primary field_used as default', () => {
    const noteTypes: AnkiNoteType[] = [
      { name: 'Kaishi 1.5k', fields: ['Word', 'Reading', 'Meaning'], field_used: 'Word', notes: 1500 },
      { name: 'Basic', fields: ['Front', 'Meaning', 'Back'], field_used: 'Front', notes: 40 },
    ];
    const info = collectFieldOptions(noteTypes);
    expect(info.defaultField).toBe('Word');
    expect(info.fields).toEqual(['Word', 'Reading', 'Meaning', 'Front', 'Back']);
  });

  it('normalizes Anki schema-18 unit separator in deck names', () => {
    expect(formatDeckDisplayName('Japanese\u001fCore 2k')).toBe('Japanese::Core 2k');
    expect(formatDeckDisplayName('Default')).toBe('Default');
  });

  it('extracts filenames from Content-Disposition headers with fallback', () => {
    expect(parseContentDispositionFilename('attachment; filename="sensei-20261121.apkg"')).toBe(
      'sensei-20261121.apkg',
    );
    expect(parseContentDispositionFilename(null, 'fallback.apkg')).toBe('fallback.apkg');
  });

  it('counts non-empty lines and formats import report summaries cleanly', () => {
    expect(countNonEmptyLines('食べる\n\n  海賊  \r\n')).toBe(2);

    const dryReport: ImportReport = {
      total: 100,
      matched: 92,
      updated: 80,
      already: 12,
      unmatched_count: 8,
      unmatched: ['おはようございます'],
      skipped_new: 15,
      dry_run: true,
      note_types: [],
      decks: [],
    };
    expect(summarizeImportReport(dryReport)).toContain('Would update 80 words');
    expect(summarizeImportReport(dryReport)).toContain('15 unstudied skipped');

    const realReport: ImportReport = { ...dryReport, dry_run: false, updated: 1, skipped_new: 0 };
    expect(summarizeImportReport(realReport)).toContain('Updated 1 word');
    expect(summarizeImportReport(realReport)).not.toContain('unstudied skipped');
  });
});
