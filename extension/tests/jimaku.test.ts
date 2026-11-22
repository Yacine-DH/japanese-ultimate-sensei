import { describe, expect, it } from 'vitest';
import type { EpisodeOut, JimakuFile } from '../src/api/client';
import {
  describeJimakuFileWarning,
  findNextImportableFile,
  formatJimakuError,
  formatJimakuFileSize,
  guessAnimeQueryFromTitle,
  isJimakuFileDimmed,
  pickDefaultJimakuFile,
  suggestNextEpisodeNumber,
} from '../src/lib/jimaku';

function makeFile(overrides: Partial<JimakuFile> = {}): JimakuFile {
  return {
    name: 'Frieren - 01.srt',
    size: 23195,
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

describe('Jimaku popup search helpers (#60)', () => {
  it('extracts clean anime query and episode number from streaming tab titles', () => {
    expect(
      guessAnimeQueryFromTitle(
        "Watch Frieren: Beyond Journey's End Episode 4 English Sub | HiAnime",
      ),
    ).toEqual({
      query: "Frieren: Beyond Journey's End",
      episodeNumber: 4,
    });
    expect(guessAnimeQueryFromTitle('Dungeon Meshi Ep. 12 - Watch Anime Online')).toEqual({
      query: 'Dungeon Meshi',
      episodeNumber: 12,
    });
  });

  it('suggests next episode number after existing episodes of the same anime', () => {
    const existing: EpisodeOut[] = [
      {
        id: 1,
        anime_id: 10,
        anime_title: "Frieren: Beyond Journey's End",
        number: 3,
        title: null,
        source: 'jimaku',
        source_filename: 'frieren03.srt',
        sub_offset_ms: 0,
        line_count: 300,
        created_at: '2026-11-21T00:00:00Z',
      },
    ];
    expect(
      suggestNextEpisodeNumber(
        {
          name: 'Sousou no Frieren',
          english_name: "Frieren: Beyond Journey's End",
          japanese_name: '葬送のフリーレン',
        },
        existing,
      ),
    ).toBe(4);
    expect(
      suggestNextEpisodeNumber(
        { name: 'Bocchi the Rock', english_name: null, japanese_name: null },
        existing,
      ),
    ).toBe(1);
  });

  it('picks recommended file first, flags unsupported/multi-episode, and formats 503/502/422 errors', () => {
    const files: JimakuFile[] = [
      makeFile({ name: 'bluray.ass', web_source: false, recommended: false }),
      makeFile({ name: 'web.srt', web_source: true, recommended: true }),
      makeFile({ name: 'pack.7z', format: '7z', supported: false }),
      makeFile({ name: '01-04.zip', format: 'zip', supported: true, multi_episode: true }),
    ];

    expect(pickDefaultJimakuFile(files)?.name).toBe('web.srt');
    expect(findNextImportableFile(files, 'bluray.ass')?.name).toBe('web.srt');
    expect(describeJimakuFileWarning(files[2]!)).toMatch(/Unsupported format/i);
    expect(describeJimakuFileWarning(files[3]!)).toMatch(/Multi-episode/i);
    expect(describeJimakuFileWarning(files[1]!)).toBeNull();
    expect(formatJimakuFileSize(23195)).toBe('22.7 KB');

    expect(formatJimakuError(503)).toContain('SENSEI_JIMAKU_API_KEY');
    expect(formatJimakuError(502)).toContain('jimaku.cc');
    expect(formatJimakuError(422, 'No Japanese lines')).toContain('No Japanese lines');
  });

  it('flags dual_language files as dimmed with warning and prefers Japanese-only files (#96)', () => {
    const dual = makeFile({
      name: 'Frieren - 01_ja-en.ass',
      dual_language: true,
      recommended: false,
    });
    const jpOnly = makeFile({
      name: 'Frieren - 01_AT-X.ass',
      web_source: false,
      dual_language: false,
      recommended: false,
    });
    const dualMulti = makeFile({
      name: 'Frieren - 01-04 [CHS, JPN].zip',
      format: 'zip',
      multi_episode: true,
      dual_language: true,
    });

    expect(isJimakuFileDimmed(dual)).toBe(true);
    expect(isJimakuFileDimmed(jpOnly)).toBe(false);
    expect(describeJimakuFileWarning(dual)).toBe('Contains non-Japanese lines');
    expect(describeJimakuFileWarning(dualMulti)).toContain('Contains non-Japanese lines');
    expect(describeJimakuFileWarning(dualMulti)).toContain('Multi-episode');
    expect(pickDefaultJimakuFile([dual, jpOnly])?.name).toBe('Frieren - 01_AT-X.ass');
    expect(pickDefaultJimakuFile([dual])?.name).toBe('Frieren - 01_ja-en.ass');
    expect(findNextImportableFile([makeFile({ name: 'bad.srt' }), dual, jpOnly], 'bad.srt')?.name).toBe(
      'Frieren - 01_AT-X.ass',
    );
  });
});
