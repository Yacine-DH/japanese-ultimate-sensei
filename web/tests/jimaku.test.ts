import { describe, expect, it } from 'vitest';
import type { EpisodeOut, JimakuFile } from '../src/api/client';
import {
  describeJimakuFileWarning,
  findNextImportableFile,
  formatJimakuError,
  formatJimakuFileSize,
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
});
