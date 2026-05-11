---
name: add-matrix-sms
description: Add SMS sending/receiving via a local Matrix homeserver bridged to Google Messages (mautrix-gmessages). Distinct from /add-matrix — that adapter is generic Matrix; this one is the Matrix→SMS bridge with channelType `sms`. Triggers on "add sms", "matrix sms", "google messages bridge", "mautrix-gmessages".
---

# Add Matrix-SMS Channel

Adds SMS support by connecting to a local Matrix homeserver running the `mautrix-gmessages` bridge. The chain looks like:

```
SMS phone ↔ Google Messages ↔ mautrix-gmessages bridge ↔ Matrix homeserver ↔ NanoClaw
```

The platform_id format is `sms:<phone>` (e.g. `sms:+12125550100`). Each contact gets one messaging group.

## Install

NanoClaw doesn't ship channels in trunk. The Matrix-SMS adapter lives in `src/channels/matrix-sms.ts` and self-registers via `src/channels/index.ts`.

### Pre-flight (idempotent)

Skip to **Prerequisites** if all of these are already true:

- `src/channels/matrix-sms.ts` exists
- `src/channels/index.ts` contains `import './matrix-sms.js';`
- `matrix-js-sdk` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Confirm the adapter file is in place

The adapter is shipped in trunk (`src/channels/matrix-sms.ts`) — no `git fetch` needed.

### 2. Confirm the self-registration import

`src/channels/index.ts` should contain `import './matrix-sms.js';` already. Append if missing.

### 3. Install matrix-js-sdk

```bash
pnpm install matrix-js-sdk@^36.2.0
```

### 4. Build

```bash
pnpm run build
```

## Prerequisites

This adapter does **not** install the bridge — it only talks to a Matrix homeserver that already runs one. You need:

1. **A Matrix homeserver** (Synapse or Conduit) reachable from the host. A local install at `http://localhost:8448` is the standard setup.
2. **The mautrix-gmessages bridge** running and paired to your phone. The bridge speaks both Matrix and Google Messages and bridges 1:1 SMS threads as Matrix DM rooms.
3. **A bot account on the homeserver** (e.g. `@nanoclaw:localhost`) with an access token. Invite this bot to the rooms the bridge creates (or set the bridge to auto-invite — typical default).

Bridge setup is out of scope for this skill. Reference: <https://docs.mau.fi/bridges/go/gmessages/setup.html>.

## Credentials

Add to `.env`:

```bash
MATRIX_URL=http://localhost:8448
MATRIX_USER_ID=@nanoclaw:localhost
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_BRIDGE_BOT=@gmessagesbot:localhost
GMESSAGES_DB=/path/to/mautrix-gmessages.db
```

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `MATRIX_URL` | yes | — | Homeserver base URL |
| `MATRIX_USER_ID` | yes | — | Bot's Matrix ID |
| `MATRIX_ACCESS_TOKEN` | yes | — | Bot's access token |
| `MATRIX_BRIDGE_BOT` | no | `@gmessagesbot:localhost` | Bridge bot user ID — bot messages from this user are filtered out (status, QR pairing, etc.) |
| `GMESSAGES_DB` | no | `docker/sms/bridge-data/gmessages.db` | mautrix-gmessages SQLite path — used to discover contact names and phone numbers |
| `SMS_READ_ONLY` | no | `false` | When `true`, accept inbound but refuse outbound. Useful for dry-run setups. |

### Getting an access token

If you registered the bot via the Matrix client (Element), open the bot's session → **Settings** > **Help & About** > scroll to **Access Token**.

Or via the API:

```bash
curl -XPOST 'http://localhost:8448/_matrix/client/v3/login' \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"nanoclaw","password":"..."}'
```

Sync to container env:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Restart

```bash
# Linux
systemctl --user restart nanoclaw-v2-*
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-*
```

## Verify

Have someone text the phone number paired with Google Messages. The bridge creates a Matrix room, the adapter discovers it from `GMESSAGES_DB`, and the message routes through the v2 router. Check `logs/nanoclaw.log` for `SMS: message received`.

To send: have an agent call its delivery (or use the CLI admin transport) to a `sms:<phone>` platform_id. Check `logs/nanoclaw.log` for `SMS: message sent`.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire SMS contacts to an agent group. Each new SMS contact appears as its own messaging group; you can wire individual contacts or accept the auto-create flow on first inbound.

## Channel Info

- **type**: `sms`
- **terminology**: One messaging group per phone number. The bridge creates one Matrix DM room per contact.
- **how-to-find-id**: Inbound messages auto-create the messaging group. To address a contact manually, the platform_id is `sms:<E.164 phone>` (e.g. `sms:+12125550100`).
- **supports-threads**: no (SMS is flat per-contact)
- **typical-use**: Personal SMS bot — the user's friends and family text the bot.
- **default-isolation**: One agent group per primary user, separate agent group for low-trust contacts (work, contractors, businesses).

## MMS / attachments

MMS images and files are downloaded via the Matrix v1.11 authenticated media endpoint and saved under `data/attachments/`. The agent sees them as `localPath` references — the same shape WhatsApp uses. Base64 image preloading and 24h image history are deferred to a separate skill.

## SMS_READ_ONLY toggle

To freeze sending while leaving inbound on (e.g. while debugging routing):

```bash
# .env
SMS_READ_ONLY=true
```

Restart. The adapter throws a clear error on outbound delivery; the agent's response gets logged but is not sent. Inbound continues normally.
