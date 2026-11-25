/**
 * Discord thread titles.
 *
 * The Discord adapter opens a thread for every channel @mention and names it
 * `Thread <timestamp>`. When such a mention starts a new per-thread session,
 * this module renames the thread after the message that started it, so a
 * channel's thread list reads as a list of questions.
 *
 * Only an auto-generated name (`Thread …`) is replaced. A thread a person
 * named is left alone, and so is everything that is not a Discord group
 * thread. The rename is best-effort: it runs from the router's session-created
 * hook, which is fire-and-forget, and any failure is logged and dropped.
 *
 * This file holds the logic and registers nothing; ./index.ts registers it.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { SessionCreatedEvent } from '../../router.js';

const DISCORD_API = 'https://discord.com/api/v10';
/** Discord allows 100 characters; leave room and keep titles scannable. */
const TITLE_MAX = 90;

/**
 * A thread name from the message that spawned the thread: its text with
 * mention tokens stripped and whitespace collapsed, capped to the title
 * budget. Empty (an attachment-only message) means no rename.
 */
export function deriveThreadTitle(content: string): string {
  let text = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object') {
      const candidate = (parsed as { text?: unknown }).text;
      text = typeof candidate === 'string' ? candidate : '';
    }
  } catch {
    // not JSON: use the content verbatim
  }
  return text
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX)
    .trim();
}

function botToken(): string | undefined {
  return readEnvFile(['DISCORD_BOT_TOKEN']).DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || undefined;
}

export async function nameSpawnedDiscordThread(event: SessionCreatedEvent): Promise<void> {
  if (event.mg.channel_type !== 'discord') return;
  if (!event.threadId || event.sessionMode !== 'per-thread' || event.mg.is_group === 0) return;

  const title = deriveThreadTitle(event.message.content);
  const threadSnowflake = event.threadId.split(':').pop();
  if (!title || !threadSnowflake) return;

  const token = botToken();
  if (!token) return;

  const url = `${DISCORD_API}/channels/${threadSnowflake}`;
  try {
    const current = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
    if (!current.ok) return;
    const channel = (await current.json()) as { name?: string };
    if (!channel.name || !/^Thread\b/i.test(channel.name)) return;

    await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: title }),
    });
  } catch (err) {
    log.warn('Discord thread rename failed', { threadId: event.threadId, err });
  }
}

