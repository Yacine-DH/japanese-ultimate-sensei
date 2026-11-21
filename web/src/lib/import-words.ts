import type { AnkiNoteType, ImportReport } from '../api/client';

export interface AnkiFieldSelectionInfo {
  fields: string[];
  defaultField: string;
}

/**
 * Collect unique field names across all detected Anki note types and determine the
 * preselected default field from the primary (largest) note type.
 */
export function collectFieldOptions(noteTypes: readonly AnkiNoteType[]): AnkiFieldSelectionInfo {
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const nt of noteTypes) {
    for (const f of nt.fields) {
      if (f && !seen.has(f)) {
        seen.add(f);
        fields.push(f);
      }
    }
  }
  const primary = noteTypes[0];
  const defaultField = primary?.field_used || fields[0] || '';
  return { fields, defaultField };
}

/**
 * Render Anki deck names cleanly (normalizing schema-18 `\x1f` unit separators to `::`).
 */
export function formatDeckDisplayName(deck: string): string {
  return deck.split('\u001f').join('::');
}

export function parseContentDispositionFilename(
  header: string | null,
  fallback = 'sensei-export.apkg',
): string {
  if (!header) return fallback;
  const match = /filename\*?=(?:UTF-8''|")?([^";\r\n]+)"?/i.exec(header);
  if (!match?.[1]) return fallback;
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return match[1].trim();
  }
}

export function countNonEmptyLines(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

export function summarizeImportReport(report: ImportReport): string {
  const verb = report.dry_run ? 'Would update' : 'Updated';
  const parts = [`${verb} ${report.updated.toLocaleString()} word${report.updated === 1 ? '' : 's'}`];
  parts.push(`${report.matched.toLocaleString()} matched`);
  if (report.already > 0) {
    parts.push(`${report.already.toLocaleString()} already set`);
  }
  if (report.skipped_new > 0) {
    parts.push(`${report.skipped_new.toLocaleString()} unstudied skipped`);
  }
  if (report.unmatched_count > 0) {
    parts.push(`${report.unmatched_count.toLocaleString()} unmatched`);
  }
  return parts.join(' · ');
}
