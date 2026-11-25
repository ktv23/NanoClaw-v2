/**
 * Integration-point test: a Discord @mention that starts a new per-thread
 * session renames the adapter's auto-named thread. Loads the module through
 * the real modules barrel and drives the real `routeInbound`; goes red if the
 * barrel import is removed.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock container runner to prevent actual Docker spawning
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-discord-thread-titles' };
});

const TEST_DIR = '/tmp/nanoclaw-test-discord-thread-titles';

import type { ChannelAdapter, ChannelDefaults } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { routeInbound } from '../../router.js';
// The real barrel: this is the line under test.
import '../index.js';
import { deriveThreadTitle } from './index.js';

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'discord',
    channelType: 'discord',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

function now(): string {
  return new Date().toISOString();
}

async function seed(): Promise<void> {
  registerChannelAdapter('discord', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  await createAgentGroup({ id: 'ag-1', name: 'Helper', folder: 'helper', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'discord:G1:C1',
    instance: 'discord',
    name: 'mtg',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function mention(id: string, threadId: string, text: string): Promise<void> {
  await routeInbound({
    channelType: 'discord',
    platformId: 'discord:G1:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Kin', senderId: 'U1', text }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function discordReturnsThreadNamed(name: string): void {
  fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ name }) };
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.stubEnv('DISCORD_BOT_TOKEN', 'test-token');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await seed();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('Discord thread titles (through the real router)', () => {
  it('renames an auto-named thread after the mention that started the session', async () => {
    discordReturnsThreadNamed('Thread 8/18/2026, 8:28 AM');

    await mention('m1', 'discord:G1:C1:9001', '<@1539002280878014484> mtg how does trample work?');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as [
      string,
      { method: string; body: string; headers: Record<string, string> },
    ];
    expect(url).toBe('https://discord.com/api/v10/channels/9001');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'mtg how does trample work?' });
    expect(init.headers.Authorization).toBe('Bot test-token');
  });

  it('leaves a thread a person named alone', async () => {
    discordReturnsThreadNamed('Helldivers play KDM');

    await mention('m1', 'discord:G1:C1:9002', '<@1539002280878014484> kdm white lion');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not rename again for a later message in the same thread', async () => {
    discordReturnsThreadNamed('Thread 8/18/2026, 8:28 AM');

    await mention('m1', 'discord:G1:C1:9003', '<@1539002280878014484> mtg first question');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await mention('m2', 'discord:G1:C1:9003', '<@1539002280878014484> mtg second question');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
