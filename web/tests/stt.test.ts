import { describe, expect, it } from 'vitest';
import type { SttJobOut, SttStatus } from '../src/api/client';
import {
  computeSttElapsedMs,
  describeSttAvailability,
  formatSttDurationMs,
  formatSttElapsedSummary,
  formatTransferBytes,
  getSttJobPollInterval,
  getSttListPollInterval,
  getSttStepIndex,
  getSttStepVisualState,
  isSttJobActive,
  isSttJobTerminal,
  mergeSttJobIntoList,
  parseEpisodeMetadataFromFilename,
  STT_POLL_INTERVAL_MS,
} from '../src/lib/stt';

function makeJob(overrides: Partial<SttJobOut> = {}): SttJobOut {
  return {
    id: 3,
    status: 'transcribing',
    anime_title: 'Frieren',
    episode_number: 2,
    title: null,
    filename: 'Frieren - 02.mkv',
    duration_ms: 1_440_000, // 24:00
    episode_id: null,
    error: null,
    created_at: '2026-11-22T18:00:00Z',
    started_at: '2026-11-22T18:00:05Z',
    finished_at: null,
    ...overrides,
  };
}

describe('STT job status & polling logic (W-7, #118)', () => {
  it('distinguishes active vs terminal job states and returns 5s poll intervals only while active', () => {
    expect(isSttJobTerminal('queued')).toBe(false);
    expect(isSttJobTerminal('extracting')).toBe(false);
    expect(isSttJobTerminal('transcribing')).toBe(false);
    expect(isSttJobTerminal('importing')).toBe(false);
    expect(isSttJobTerminal('done')).toBe(true);
    expect(isSttJobTerminal('error')).toBe(true);

    expect(isSttJobActive(makeJob({ status: 'extracting' }))).toBe(true);
    expect(isSttJobActive(makeJob({ status: 'done' }))).toBe(false);
    expect(isSttJobActive(null)).toBe(false);

    expect(getSttJobPollInterval(makeJob({ status: 'queued' }))).toBe(STT_POLL_INTERVAL_MS);
    expect(getSttJobPollInterval(makeJob({ status: 'transcribing' }))).toBe(STT_POLL_INTERVAL_MS);
    expect(getSttJobPollInterval(makeJob({ status: 'done' }))).toBe(false);
    expect(getSttJobPollInterval(makeJob({ status: 'error' }))).toBe(false);
    expect(getSttJobPollInterval(undefined)).toBe(false);

    expect(
      getSttListPollInterval([makeJob({ id: 1, status: 'done' }), makeJob({ id: 2, status: 'error' })]),
    ).toBe(false);
    expect(
      getSttListPollInterval([
        makeJob({ id: 1, status: 'done' }),
        makeJob({ id: 2, status: 'importing' }),
      ]),
    ).toBe(STT_POLL_INTERVAL_MS);
    expect(getSttListPollInterval([])).toBe(false);
  });

  it('computes pipeline step indices and visual states cleanly across the 5 stages + error', () => {
    expect(getSttStepIndex('queued')).toBe(0);
    expect(getSttStepIndex('extracting')).toBe(1);
    expect(getSttStepIndex('transcribing')).toBe(2);
    expect(getSttStepIndex('importing')).toBe(3);
    expect(getSttStepIndex('done')).toBe(4);
    expect(getSttStepIndex('error')).toBe(-1);

    expect(getSttStepVisualState('queued', 'transcribing')).toBe('done');
    expect(getSttStepVisualState('extracting', 'transcribing')).toBe('done');
    expect(getSttStepVisualState('transcribing', 'transcribing')).toBe('active');
    expect(getSttStepVisualState('importing', 'transcribing')).toBe('pending');
    expect(getSttStepVisualState('done', 'transcribing')).toBe('pending');

    expect(getSttStepVisualState('done', 'done')).toBe('done');
    expect(getSttStepVisualState('queued', 'error')).toBe('error');
    expect(getSttStepVisualState('transcribing', 'error')).toBe('pending');
  });

  it('calculates elapsed time against duration_ms for running, completed, and failed jobs', () => {
    const running = makeJob();
    const now = Date.parse('2026-11-22T18:01:47Z'); // 102 s after started_at
    expect(computeSttElapsedMs(running, now)).toBe(102_000);
    expect(formatSttDurationMs(102_000)).toBe('1:42');
    expect(formatSttDurationMs(1_440_000)).toBe('24:00');
    expect(formatSttDurationMs(3_723_000)).toBe('1:02:03');
    expect(formatSttDurationMs(null)).toBe('');

    expect(formatSttElapsedSummary(running, now)).toBe('Elapsed 1:42 · audio 24:00');

    const queuedNoDuration = makeJob({
      status: 'queued',
      started_at: null,
      duration_ms: null,
    });
    expect(formatSttElapsedSummary(queuedNoDuration, Date.parse('2026-11-22T18:00:12Z'))).toBe(
      'Elapsed 0:12',
    );

    const finished = makeJob({
      status: 'done',
      episode_id: 42,
      finished_at: '2026-11-22T18:03:17Z', // 3m 12s after started_at
    });
    expect(formatSttElapsedSummary(finished, now + 999_000)).toBe(
      'Finished in 3:12 · audio 24:00',
    );

    const failed = makeJob({
      status: 'error',
      error: 'speech-to-text server unreachable',
      finished_at: '2026-11-22T18:00:25Z', // 20s after started_at
    });
    expect(formatSttElapsedSummary(failed, now)).toBe('Failed after 0:20 · audio 24:00');
  });

  it('describes STT availability and graceful degradation hints', () => {
    const unconfigured: SttStatus = {
      configured: false,
      reachable: false,
      base_url: null,
      model: null,
      detail: 'SENSEI_STT_BASE_URL not set',
    };
    const resUnconf = describeSttAvailability(unconfigured);
    expect(resUnconf.available).toBe(false);
    expect(resUnconf.hint).toMatch(/whisper-server/i);

    const unreachable: SttStatus = {
      configured: true,
      reachable: false,
      base_url: 'http://precision:8080/v1',
      model: null,
      detail: 'Connection refused',
    };
    const resUnreach = describeSttAvailability(unreachable);
    expect(resUnreach.available).toBe(false);
    expect(resUnreach.hint).toBe('Start whisper-server on the laptop.');

    const ready: SttStatus = {
      configured: true,
      reachable: true,
      base_url: 'http://precision:8080/v1',
      model: 'large-v3-turbo',
      detail: 'ok',
    };
    const resReady = describeSttAvailability(ready);
    expect(resReady.available).toBe(true);
    expect(resReady.headline).toContain('large-v3-turbo');
  });

  it('parses anime title and episode number from common release filenames', () => {
    expect(
      parseEpisodeMetadataFromFilename('[SubsPlease] Sousou no Frieren - 02 (1080p) [F02B9CEE].mkv'),
    ).toEqual({
      animeTitle: 'Sousou no Frieren',
      episodeNumber: '2',
    });

    expect(parseEpisodeMetadataFromFilename('Dungeon.Meshi.S01E07.1080p.WEB-DL.mkv')).toEqual({
      animeTitle: 'Dungeon Meshi',
      episodeNumber: '7',
    });

    expect(parseEpisodeMetadataFromFilename('Kaguya-sama Ep 03v2 [BD].mp4')).toEqual({
      animeTitle: 'Kaguya-sama',
      episodeNumber: '3',
    });

    expect(parseEpisodeMetadataFromFilename('Bocchi_the_Rock_05.mkv')).toEqual({
      animeTitle: 'Bocchi the Rock',
      episodeNumber: '5',
    });

    expect(parseEpisodeMetadataFromFilename('Spirited_Away.mkv')).toEqual({
      animeTitle: 'Spirited Away',
      episodeNumber: '',
    });
  });

  it('merges updated jobs newest-first without duplicates and formats transfer sizes', () => {
    const j1 = makeJob({ id: 1, status: 'done', episode_id: 10 });
    const j2 = makeJob({ id: 2, status: 'queued' });
    const j2Updated = makeJob({ id: 2, status: 'transcribing' });
    const j3 = makeJob({ id: 3, status: 'queued' });

    expect(mergeSttJobIntoList([j2, j1], j2Updated).map((j) => `${j.id}:${j.status}`)).toEqual([
      '2:transcribing',
      '1:done',
    ]);
    expect(mergeSttJobIntoList([j2, j1], j3).map((j) => j.id)).toEqual([3, 2, 1]);

    expect(formatTransferBytes(512)).toBe('512 B');
    expect(formatTransferBytes(1024 * 500)).toBe('500.0 KB');
    expect(formatTransferBytes(1024 * 1024 * 412.5)).toBe('412.5 MB');
    expect(formatTransferBytes(1024 * 1024 * 1024 * 1.5)).toBe('1.50 GB');
  });
});
