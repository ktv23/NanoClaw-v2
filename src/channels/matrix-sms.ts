/**
 * Matrix → SMS channel adapter (v2) — port of v1's custom `sms` channel.
 *
 * Connects to a local Matrix homeserver running the `mautrix-gmessages`
 * bridge so the agent can send/receive SMS via Google Messages on a paired
 * phone. The chain is:
 *
 *   SMS phone ↔ Google Messages ↔ mautrix-gmessages ↔ Matrix homeserver ↔ NanoClaw
 *
 * Implements ChannelAdapter directly (no Chat SDK bridge — there is no
 * public chat-adapter for this bridge topology). channelType is `sms`,
 * matching v1's JID convention (`sms:<phone>`) and the v1→v2 migration
 * mapping.
 *
 * Env vars (read from .env):
 *   MATRIX_URL              http://localhost:8448
 *   MATRIX_USER_ID          @nanoclaw:localhost
 *   MATRIX_ACCESS_TOKEN     syt_...
 *   MATRIX_BRIDGE_BOT       @gmessagesbot:localhost   (default)
 *   GMESSAGES_DB            path to mautrix-gmessages SQLite (optional —
 *                           used to discover contacts; falls back to
 *                           lazy room learning when missing)
 *   SMS_READ_ONLY           true → accept inbound, refuse outbound
 *
 * MMS attachments use the v1.11 authenticated media endpoint (older
 * `/_matrix/media/v3/download/` paths 404 on Synapse 1.105+). Downloaded
 * files land in `data/attachments/` and are surfaced to the agent as a
 * `localPath` reference (NOT base64-inlined) — same shape WhatsApp uses.
 * The 24h image-history and base64 pre-loading from v1 are deferred to
 * a separate skill.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { extForMime } from '../attachment-naming.js';
import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const SMS_CHAR_LIMIT = 1600;
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

// ── types ──────────────────────────────────────────────────────────────────

interface BridgeContact {
  roomId: string; // Matrix room ID  e.g. !abc:localhost
  ghostId: string; // bridge internal  e.g. 1.5
  name: string; // display name
  phone: string; // E.164 or short code
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Convert an E.164 phone number to a v2 platform_id ( `sms:<phone>` ). */
function phoneToPlatformId(phone: string): string {
  return `sms:${phone}`;
}

/**
 * Read the mautrix-gmessages SQLite database and return all 1:1 DM portals
 * with their contact name and phone number. Best-effort — returns [] when
 * the DB doesn't exist, with the channel falling back to lazy room learning
 * from inbound timeline events.
 */
function loadBridgeContacts(dbPath: string): BridgeContact[] {
  if (!fs.existsSync(dbPath)) {
    log.warn('SMS: bridge DB not found, contact discovery skipped', { dbPath });
    return [];
  }

  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT p.mxid           AS roomId,
                p.other_user_id  AS ghostId,
                g.name           AS name,
                g.identifiers    AS identifiers
           FROM portal p
           JOIN ghost g ON g.id = p.other_user_id
                       AND (g.bridge_id = p.bridge_id OR g.bridge_id IS NULL)
          WHERE p.room_type = 'dm'
            AND p.mxid IS NOT NULL
            AND p.other_user_id IS NOT NULL`,
      )
      .all() as Array<{
      roomId: string;
      ghostId: string;
      name: string;
      identifiers: string;
    }>;
    db.close();

    const contacts: BridgeContact[] = [];
    for (const row of rows) {
      const phone = parsePhoneFromIdentifiers(row.identifiers) ?? row.ghostId;
      contacts.push({
        roomId: row.roomId,
        ghostId: row.ghostId,
        name: row.name || row.ghostId,
        phone,
      });
    }
    return contacts;
  } catch (err) {
    log.warn('SMS: failed to read bridge DB', { err, dbPath });
    return [];
  }
}

/**
 * Parse the bridge's `identifiers` JSON array to extract an E.164 phone
 * number. Looks like: `["tel:+12125550100"]`.
 */
function parsePhoneFromIdentifiers(identifiers: string): string | null {
  try {
    const list: string[] = JSON.parse(identifiers);
    for (const entry of list) {
      if (entry.startsWith('tel:')) return entry.slice(4);
    }
  } catch {
    // malformed JSON — ignore
  }
  return null;
}

/**
 * Translate `mxc://server/mediaId` to the v1.11 authenticated media URL.
 * The legacy `/_matrix/media/v3/download/` endpoint returns 404 on Synapse
 * 1.105+ — only the new authenticated endpoint works. Returns null on
 * unparseable input.
 */
function mxcToHttp(matrixUrl: string, mxc: string): string | null {
  const m = mxc.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return `${matrixUrl}/_matrix/client/v1/media/download/${m[1]}/${m[2]}`;
}

// ── matrix client wrapper ──────────────────────────────────────────────────

interface MatrixOptions {
  baseUrl: string;
  userId: string;
  accessToken: string;
}

// matrix-js-sdk has no compile-time types here (the dep is added but the
// adapter is loaded lazily so missing-deps installs don't blow up). The
// surface we touch is small and stable across versions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createMatrixClient(opts: MatrixOptions): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — optional dep, no types required
  const sdk = await import('matrix-js-sdk');
  const silentLogger = {
    ...console,
    debug: () => {},
    getChild: () => silentLogger,
  };
  return sdk.createClient({
    baseUrl: opts.baseUrl,
    userId: opts.userId,
    accessToken: opts.accessToken,
    logger: silentLogger,
  });
}

// ── adapter ────────────────────────────────────────────────────────────────

interface AdapterConfig {
  matrixUrl: string;
  matrixUserId: string;
  matrixAccessToken: string;
  bridgeBotUserId: string;
  bridgeDbPath: string;
  readOnly: boolean;
}

function createAdapter(cfg: AdapterConfig): ChannelAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null;
  let synced = false;
  let setupConfig: ChannelSetup | null = null;

  /** roomId → platformId (`sms:<phone>`) */
  const roomToPlatform = new Map<string, string>();
  /** platformId → roomId */
  const platformToRoom = new Map<string, string>();
  /** roomId → contact's Matrix ghost user ID (e.g. "@gmessages_1.5:localhost") */
  const roomToContactGhost = new Map<string, string>();
  /** platformId → contact's display name */
  const platformToName = new Map<string, string>();

  // ── bridge DB → known contacts ────────────────────────────────────────────

  function refreshContactsFromBridgeDb(): void {
    const contacts = loadBridgeContacts(cfg.bridgeDbPath);
    const domain = cfg.matrixUserId.split(':')[1];
    for (const contact of contacts) {
      const platformId = phoneToPlatformId(contact.phone);
      roomToPlatform.set(contact.roomId, platformId);
      platformToRoom.set(platformId, contact.roomId);
      platformToName.set(platformId, contact.name);

      // p.other_user_id stores the raw ghost ID (e.g. "1.5"); reconstruct the
      // full Matrix user ID so it matches `senderId` in timeline events.
      const ghostMxid = contact.ghostId.startsWith('@') ? contact.ghostId : `@gmessages_${contact.ghostId}:${domain}`;
      roomToContactGhost.set(contact.roomId, ghostMxid);

      // Surface the name to the host so /manage-channels can label it.
      // is_group=false — every gmessages portal is a 1:1 SMS thread.
      setupConfig?.onMetadata(platformId, contact.name, false);
    }
    log.info('SMS: loaded contacts from bridge DB', { count: contacts.length });
  }

  // ── timeline handler ──────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleTimelineEvent(event: any, room: any): Promise<void> {
    if (event.getType() !== 'm.room.message') return;
    if (!setupConfig) return;

    const senderId: string = event.getSender();
    if (senderId === cfg.matrixUserId) return;

    const content = event.getContent();

    // Ignore bridge-bot messages (QR pairing prompts, status notices). v1
    // exposed a QR generator here; v2 setup uses the install skill instead.
    if (senderId === cfg.bridgeBotUserId) return;

    // Only handle ghost-user messages on the local homeserver — this guards
    // against any spoofed inbound arriving via federation.
    const domain = cfg.matrixUserId.split(':')[1];
    if (!senderId.startsWith('@gmessages_') || !senderId.endsWith(`:${domain}`)) return;

    const roomId: string = room.roomId;
    const platformId = roomToPlatform.get(roomId);
    if (!platformId) {
      // Unknown room — likely a brand-new contact that the bridge has just
      // created. Refresh from the DB and try again.
      refreshContactsFromBridgeDb();
      const refreshed = roomToPlatform.get(roomId);
      if (!refreshed) {
        log.debug('SMS: timeline event in unknown room — skipping', { roomId, senderId });
        return;
      }
    }
    const resolvedPlatformId = roomToPlatform.get(roomId)!;

    const timestamp = new Date(event.getTs()).toISOString();
    const msgId: string = event.getId() || `sms-${roomId}-${event.getTs()}`;
    const contactGhost = roomToContactGhost.get(roomId);
    const isFromMe = contactGhost ? senderId !== contactGhost : false;
    if (isFromMe) {
      // The user typed this on their own phone — don't loop it back to the
      // agent. v1 surfaced these for context but the v2 router would treat
      // them as inbound from the bot itself.
      return;
    }
    const senderName = platformToName.get(resolvedPlatformId) ?? senderId;

    // Build the inbound message body. MMS images / files are downloaded to
    // data/attachments/ and surfaced as `localPath` references (the same
    // shape WhatsApp uses) — NOT base64-inlined. Multimodal pre-loading is
    // a separate skill.
    let text: string = typeof content.body === 'string' ? content.body : '';
    const attachments: Array<{ type: string; name: string; localPath: string; mimeType?: string }> = [];

    if ((content.msgtype === 'm.image' || content.msgtype === 'm.file') && typeof content.url === 'string') {
      const downloaded = await downloadMatrixAttachment(
        content.url,
        typeof content.body === 'string' ? content.body : `attachment-${Date.now()}`,
        content.msgtype,
        content.info?.mimetype,
      );
      if (downloaded) {
        attachments.push(downloaded);
        if (!text) text = `[Attachment: ${downloaded.name}]`;
      } else {
        text = text || `[Attachment download failed]`;
      }
    }

    if (!text && attachments.length === 0) return;

    const inbound: InboundMessage = {
      id: msgId,
      kind: 'chat',
      // SMS is always a 1:1 DM in this bridge, so flag as a confirmed
      // mention — that's how the router auto-creates the messaging group.
      isMention: true,
      isGroup: false,
      content: {
        text,
        sender: resolvedPlatformId,
        senderName,
        ...(attachments.length > 0 && { attachments }),
        fromMe: false,
        isGroup: false,
      },
      timestamp,
    };

    // Surface metadata for sync — nice-to-have, idempotent in the host.
    setupConfig.onMetadata(resolvedPlatformId, senderName, false);
    setupConfig.onInbound(resolvedPlatformId, null, inbound);
    log.info('SMS: message received', {
      platformId: resolvedPlatformId,
      senderName,
      msgtype: content.msgtype,
    });
  }

  /**
   * Download an MMS attachment via the v1.11 authenticated media endpoint
   * and stash it in `data/attachments/`. Returns null on failure (caller
   * surfaces a placeholder string instead). Mirrors WhatsApp's path-reference
   * approach so downstream session-manager treats it identically — no base64
   * preloading.
   */
  async function downloadMatrixAttachment(
    mxcUrl: string,
    originalName: string,
    msgtype: string,
    mimetype?: string,
  ): Promise<{ type: string; name: string; localPath: string; mimeType?: string } | null> {
    try {
      const httpUrl = mxcToHttp(cfg.matrixUrl, mxcUrl);
      if (!httpUrl) return null;

      const response = await fetch(httpUrl, {
        headers: { Authorization: `Bearer ${cfg.matrixAccessToken}` },
      });
      if (!response.ok) {
        log.warn('SMS: attachment download failed', { status: response.status, mxcUrl });
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());

      fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

      // Defend against attacker-controlled `body` (the SMS sender). Scrub
      // anything that isn't a clean basename.
      const baseName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = (() => {
        const fromMime = extForMime(mimetype);
        if (fromMime) return `.${fromMime}`;
        const has = path.extname(baseName);
        if (has) return '';
        return msgtype === 'm.image' ? '.jpg' : '';
      })();
      const safeName = `${Date.now()}_${baseName}${ext}`;
      if (!isSafeAttachmentName(safeName)) {
        log.warn('SMS: refused unsafe attachment filename', { originalName });
        return null;
      }
      const filePath = path.join(ATTACHMENTS_DIR, safeName);
      fs.writeFileSync(filePath, buffer);
      log.info('SMS: attachment saved', { filePath, bytes: buffer.length });

      const type = msgtype === 'm.image' ? 'image' : 'document';
      return {
        type,
        name: safeName,
        localPath: `attachments/${safeName}`,
        ...(mimetype && { mimeType: mimetype }),
      };
    } catch (err) {
      log.warn('SMS: failed to download attachment', { err, mxcUrl });
      return null;
    }
  }

  // ── adapter contract ──────────────────────────────────────────────────────

  const adapter: ChannelAdapter = {
    name: 'matrix-sms',
    channelType: 'sms',
    supportsThreads: false,

    async setup(hostConfig: ChannelSetup): Promise<void> {
      setupConfig = hostConfig;

      // Load contact map BEFORE connecting so the first sync's timeline
      // events resolve against a populated table.
      refreshContactsFromBridgeDb();

      client = await createMatrixClient({
        baseUrl: cfg.matrixUrl,
        userId: cfg.matrixUserId,
        accessToken: cfg.matrixAccessToken,
      });

      await new Promise<void>((resolve, reject) => {
        // Auto-join when the bridge invites us into a brand-new contact's room.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.on('RoomMember.membership', async (_event: any, member: any) => {
          if (member.userId === cfg.matrixUserId && member.membership === 'invite') {
            try {
              await client.joinRoom(member.roomId);
              log.info('SMS: joined new Matrix room', { roomId: member.roomId });
              refreshContactsFromBridgeDb();
            } catch (err) {
              log.warn('SMS: failed to join room', { err, roomId: member.roomId });
            }
          }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.on('Room.timeline', (event: any, room: any) => {
          handleTimelineEvent(event, room).catch((err) => log.error('SMS: timeline event error', { err }));
        });

        const onSync = (state: string) => {
          if (state === 'PREPARED') {
            client.removeListener('sync', onSync);
            synced = true;
            log.info('SMS: Matrix client synced and ready', { matrixUrl: cfg.matrixUrl });
            resolve();
          } else if (state === 'ERROR') {
            client.removeListener('sync', onSync);
            log.error('SMS: Matrix sync failed', { state });
            reject(new Error(`Matrix sync failed with state: ${state}`));
          }
          // Ignore intermediate states (SYNCING, RECONNECTING, …).
        };
        client.on('sync', onSync);

        client.startClient({ initialSyncLimit: 10 });
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        try {
          client.stopClient();
        } catch (err) {
          log.warn('SMS: error stopping Matrix client', { err });
        }
        client = null;
        synced = false;
        log.info('SMS: Matrix client stopped');
      }
    },

    isConnected(): boolean {
      return client !== null && synced;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (cfg.readOnly) {
        log.warn('SMS: send blocked (SMS_READ_ONLY=true)', { platformId });
        // Throw so the agent sees a sensible error in the delivery log,
        // rather than a silent no-op that looks like the message went out.
        throw new Error('SMS sending is disabled (SMS_READ_ONLY=true).');
      }

      if (!client || !synced) {
        log.warn('SMS: client not connected, dropping outbound', { platformId });
        return undefined;
      }

      const roomId = platformToRoom.get(platformId);
      if (!roomId) {
        // The agent might be addressing a contact we haven't seen yet.
        // Refresh once and retry — saves a restart for fresh contacts.
        refreshContactsFromBridgeDb();
        const refreshed = platformToRoom.get(platformId);
        if (!refreshed) {
          log.warn('SMS: no Matrix room found for platform_id', { platformId });
          return undefined;
        }
      }
      const resolvedRoomId = platformToRoom.get(platformId)!;

      // Outbound shape: agents send `{ text }` or `{ markdown }`. SMS is
      // plain text — strip nothing here, but split long messages across
      // SMS_CHAR_LIMIT chunks (carriers reject larger).
      const content = message.content as Record<string, unknown> | undefined;
      const text = (content?.markdown as string) ?? (content?.text as string) ?? '';
      if (!text) {
        log.debug('SMS: deliver called with no text content, skipping', { platformId });
        return undefined;
      }

      try {
        if (text.length <= SMS_CHAR_LIMIT) {
          const sent = await client.sendTextMessage(resolvedRoomId, text);
          log.info('SMS: message sent', { platformId, length: text.length });
          return sent?.event_id;
        }
        let lastId: string | undefined;
        for (let i = 0; i < text.length; i += SMS_CHAR_LIMIT) {
          const chunk = text.slice(i, i + SMS_CHAR_LIMIT);
          const sent = await client.sendTextMessage(resolvedRoomId, chunk);
          lastId = sent?.event_id ?? lastId;
        }
        log.info('SMS: long message sent in chunks', { platformId, length: text.length });
        return lastId;
      } catch (err) {
        log.error('SMS: failed to send message', { platformId, err });
        throw err;
      }
    },

    async syncConversations(): Promise<ConversationInfo[]> {
      const out: ConversationInfo[] = [];
      for (const [platformId, name] of platformToName) {
        out.push({ platformId, name, isGroup: false });
      }
      return out;
    },

    async resolveChannelName(platformId: string): Promise<string | null> {
      return platformToName.get(platformId) ?? null;
    },
  };

  return adapter;
}

// ── registration ───────────────────────────────────────────────────────────

registerChannelAdapter('matrix-sms', {
  factory: () => {
    const env = readEnvFile([
      'MATRIX_URL',
      'MATRIX_USER_ID',
      'MATRIX_ACCESS_TOKEN',
      'MATRIX_BRIDGE_BOT',
      'GMESSAGES_DB',
      'SMS_READ_ONLY',
    ]);

    const matrixUrl = process.env.MATRIX_URL || env.MATRIX_URL || '';
    const matrixUserId = process.env.MATRIX_USER_ID || env.MATRIX_USER_ID || '';
    const matrixAccessToken = process.env.MATRIX_ACCESS_TOKEN || env.MATRIX_ACCESS_TOKEN || '';
    const bridgeBotUserId = process.env.MATRIX_BRIDGE_BOT || env.MATRIX_BRIDGE_BOT || '@gmessagesbot:localhost';
    const bridgeDbPath =
      process.env.GMESSAGES_DB || env.GMESSAGES_DB || path.join(process.cwd(), 'docker/sms/bridge-data/gmessages.db');
    const readOnly = (process.env.SMS_READ_ONLY || env.SMS_READ_ONLY) === 'true';

    if (!matrixUrl || !matrixUserId || !matrixAccessToken) {
      log.warn('SMS: MATRIX_URL, MATRIX_USER_ID, or MATRIX_ACCESS_TOKEN not set — skipping');
      return null;
    }

    return createAdapter({
      matrixUrl,
      matrixUserId,
      matrixAccessToken,
      bridgeBotUserId,
      bridgeDbPath,
      readOnly,
    });
  },
});
