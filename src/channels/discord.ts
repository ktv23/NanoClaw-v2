/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true matches the
 * declared supportsThreads (the skill-installed install-style knob) so
 * mention-sticky engagement stays bounded per-thread. dm.threads:false —
 * DM replies land top-level, one session per DM.
 */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Discord message forwards carry their content in `message_snapshots`, not
 * `content` (`message_reference.type === 1` means FORWARD; 0 is a normal
 * reply). The adapter only reads `content`/`attachments`, so without this the
 * agent sees an empty message. Unwrap the snapshot back into the payload so
 * text, attachment download, and formatting all ride the existing path.
 * Note: snapshots contain no author, so the original sender is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => s?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = snaps
    .map((m: any) => m.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fwdAttachments = snaps.flatMap((m: any) => m.attachments ?? []);
  if (fwdAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...fwdAttachments];
  }
}

function unwrapForwards(adapter: ReturnType<typeof createDiscordAdapter>): void {
  const a = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
  };
  const orig = a.handleForwardedMessage.bind(adapter);
  a.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    return orig(data, options);
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    unwrapForwards(discordAdapter);
    const token = env.DISCORD_BOT_TOKEN;
    const bridge = createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: token,
      extractReplyContext,
      supportsThreads: true,
      defaults: DISCORD_DEFAULTS,
      // Discord rejects messages over 2000 chars; without this the bridge
      // would let long agent replies fail instead of splitting them.
      maxTextLength: 2000,
    });

    // Give bot-spawned threads a meaningful name. When the agent is @mentioned
    // in a group channel (threads:on), Discord opens a thread auto-named
    // "Thread <timestamp>". The router fires this once, on the new per-thread
    // session, with a title derived from the triggering message. We rename ONLY
    // that auto-generated name — never a thread a human titled deliberately.
    const wrapped: ChannelAdapter = {
      ...bridge,
      setThreadTitle: async (_platformId: string, threadId: string, title: string): Promise<void> => {
        const snowflake = threadId.split(':').pop();
        const name = title.trim().slice(0, 90);
        if (!snowflake || !name) return;
        try {
          const res = await fetch(`https://discord.com/api/v10/channels/${snowflake}`, {
            headers: { Authorization: `Bot ${token}` },
          });
          if (!res.ok) return;
          const chan = (await res.json()) as { name?: string };
          // Only auto-generated thread names ("Thread 8/18/2026, 8:28 AM") get
          // renamed; a user-named thread (e.g. "Helldivers play KDM") is left alone.
          if (!chan.name || !/^Thread\b/i.test(chan.name)) return;
          await fetch(`https://discord.com/api/v10/channels/${snowflake}`, {
            method: 'PATCH',
            headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
        } catch (err) {
          log.warn('discord setThreadTitle failed', { threadId, err });
        }
      },
    };
    return wrapped;
  },
  defaults: DISCORD_DEFAULTS,
});
