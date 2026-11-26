import { describe, expect, it } from 'vitest';
import type { EpisodeOut, JimakuFile } from '../src/api/client';
import {
  describeJimakuFileWarning,
  findNextImportableFile,
  formatJimakuError,
  formatJimakuFileSize,
  isJimakuFileDimmed,
  pickDefaultJimakuFile,
  suggestNextEpisodeNumber,
} from '../src/lib/jimaku';

function makeFile(overrides: Partial<JimakuFile> = {}): JimakuFile {
  return {
    name: 'Frieren - 01.srt',
    size: 20480,
    last_modified: '2024-03-03T14:43:52Z',
    format: 'srt',
    supported: true,
    episode: 1,
    multi_episode: false,
    web_source: true,
    dual_language: false,
    recommended: false,
    ...overrides,
  };
}

describe('web Jimaku search helpers (#60)', () => {
  it('prefills next episode number and picks recommended/next importable files', () => {
    const existing: EpisodeOut[] = [
      {
        id: 1,
        anime_id: 1,
        anime_title: 'Sousou no Frieren',
        number: 5,
        title: null,
        source: 'jimaku',
        source_filename: 'frieren05.ass',
        sub_offset_ms: 0,
        sync_points: [],
        line_count: 290,
        created_at: '2026-11-21T00:00:00Z',
      },
    ];
    expect(
      suggestNextEpisodeNumber(
        { name: 'Sousou no Frieren', english_name: 'Frieren', japanese_name: null },
        existing,
      ),
    ).toBe(6);

    const files = [
      makeFile({ name: 'a.srt', recommended: true }),
      makeFile({ name: 'b.ass', recommended: false }),
      makeFile({ name: 'c.sup', format: 'sup', supported: false }),
    ];
    expect(pickDefaultJimakuFile(files)?.name).toBe('a.srt');
    expect(findNextImportableFile(files, 'a.srt')?.name).toBe('b.ass');
    expect(describeJimakuFileWarning(files[2]!)).toMatch(/Unsupported/i);
    expect(formatJimakuFileSize(20480)).toBe('20.0 KB');
    expect(formatJimakuError(503)).toContain('SENSEI_JIMAKU_API_KEY');
    expect(formatJimakuError(502)).toContain('502');
    expect(formatJimakuError(422, 'Ambiguous zip')).toContain('Ambiguous zip');
  });

  it('dims dual_language files, warns about non-Japanese lines, and prefers Japanese-only files (#96)', () => {
    const dual = makeFile({
      name: 'Frieren - 02_ja-en.srt',
      dual_language: true,
      recommended: false,
    });
    const jpOnly = makeFile({
      name: 'Frieren - 02_AT-X.ass',
      web_source: false,
      dual_language: false,
      recommended: false,
    });
    const dualMulti = makeFile({
      name: 'Frieren - 01-04 [JPSC].zip',
      format: 'zip',
      multi_episode: true,
      dual_language: true,
    });

    expect(isJimakuFileDimmed(dual)).toBe(true);
    expect(isJimakuFileDimmed(jpOnly)).toBe(false);
    expect(describeJimakuFileWarning(dual)).toBe('Contains non-Japanese lines');
    expect(describeJimakuFileWarning(dualMulti)).toContain('Contains non-Japanese lines');
    expect(describeJimakuFileWarning(dualMulti)).toContain('Multi-episode');
    expect(pickDefaultJimakuFile([dual, jpOnly])?.name).toBe('Frieren - 02_AT-X.ass');
    expect(pickDefaultJimakuFile([dual])?.name).toBe('Frieren - 02_ja-en.srt');
    expect(findNextImportableFile([makeFile({ name: 'bad.srt' }), dual, jpOnly], 'bad.srt')?.name).toBe(
      'Frieren - 02_AT-X.ass',
    );
  });
});
