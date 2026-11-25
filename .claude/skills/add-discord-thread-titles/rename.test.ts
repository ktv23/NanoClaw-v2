/**
 * Unit tests for the Discord thread rename logic (./rename.ts): title
 * derivation and the cases the rename skips. The wiring is covered by
 * discord-thread-titles.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../../log.js';
import type { SessionCreatedEvent } from '../../router.js';
import { deriveThreadTitle, nameSpawnedDiscordThread } from './rename.js';

function event(overrides: {
  channelType?: string;
  isGroup?: 0 | 1;
  threadId?: string | null;
  sessionMode?: string;
  text?: string;
}): SessionCreatedEvent {
  return {
    session: { id: 's1' },
    mg: { id: 'mg-1', channel_type: overrides.channelType ?? 'discord', is_group: overrides.isGroup ?? 1 },
    platformId: 'discord:G1:C1',
    threadId: overrides.threadId === undefined ? 'discord:G1:C1:9001' : overrides.threadId,
    sessionMode: overrides.sessionMode ?? 'per-thread',
    message: {
      id: 'm1',
      kind: 'chat-sdk',
      content: JSON.stringify({ text: overrides.text ?? '<@1> mtg what is trample?' }),
      timestamp: new Date().toISOString(),
    },
  } as unknown as SessionCreatedEvent;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('DISCORD_BOT_TOKEN', 'test-token');
  fetchMock = vi.fn(async (_url: string, init?: { method?: string }) =>
    init?.method === 'PATCH'
      ? { ok: true, json: async () => ({}) }
      : { ok: true, json: async () => ({ name: 'Thread 8/18/2026, 8:28 AM' }) },
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('nameSpawnedDiscordThread', () => {
  it('renames an auto-named Discord group thread', async () => {
    await nameSpawnedDiscordThread(event({}));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body)).toEqual({ name: 'mtg what is trample?' });
  });

  it('skips another platform', async () => {
    await nameSpawnedDiscordThread(event({ channelType: 'telegram' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a direct message, a session with no thread, and a shared session', async () => {
    await nameSpawnedDiscordThread(event({ isGroup: 0 }));
    await nameSpawnedDiscordThread(event({ threadId: null }));
    await nameSpawnedDiscordThread(event({ sessionMode: 'shared' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a message with no text', async () => {
    await nameSpawnedDiscordThread(event({ text: '<@1>' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when no bot token is configured', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', '');
    await nameSpawnedDiscordThread(event({}));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not rename when Discord refuses the lookup, and swallows a network error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    await nameSpawnedDiscordThread(event({}));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(nameSpawnedDiscordThread(event({}))).resolves.toBeUndefined();
  });

  it('logs a rename Discord refuses, since a 403 or 429 is not an exception', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === 'PATCH'
        ? { ok: false, status: 403, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ name: 'Thread 8/18/2026, 8:28 AM' }) },
    );

    await nameSpawnedDiscordThread(event({}));

    expect(log.warn).toHaveBeenCalledWith(
      'Discord thread rename failed',
      expect.objectContaining({ step: 'rename', status: 403 }),
    );
  });
});

describe('deriveThreadTitle', () => {
  it('strips user, nickname and role mentions and collapses whitespace', () => {
    expect(deriveThreadTitle(JSON.stringify({ text: '<@1> <@!2> <@&3>  mtg   what   is trample?' }))).toBe(
      'mtg what is trample?',
    );
  });

  it('caps the title at 90 characters', () => {
    expect(deriveThreadTitle(JSON.stringify({ text: 'x'.repeat(200) }))).toHaveLength(90);
  });

  it('returns an empty title for a message with no text', () => {
    expect(deriveThreadTitle(JSON.stringify({ text: '<@1>' }))).toBe('');
    expect(deriveThreadTitle(JSON.stringify({ attachments: [{ name: 'photo.jpg' }] }))).toBe('');
  });

  it('uses non-JSON content verbatim', () => {
    expect(deriveThreadTitle('plain text')).toBe('plain text');
  });
});
