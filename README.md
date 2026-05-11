# NanoClaw — Personal Assistant

My personal AI assistant built on [NanoClaw](https://github.com/nanocoai/nanoclaw). Nova runs in an isolated Docker container and is reachable via Telegram and SMS.

## What's Set Up

- **Telegram** — Nova responds to all messages in a private chat; no trigger word needed
- **SMS/RCS** — Nova receives SMS and RCS via Google Messages (mautrix-gmessages bridge + Synapse Matrix homeserver); responds only when triggered
- **Prusa printer** — Nova can check printer status, active job progress, and file list (read-only via PrusaLink); set `PRUSA_URL` and `PRUSA_API_KEY` in `.env` to activate
- **PDF Reader** — Nova can read PDF documents (text extraction via poppler)
- **Scheduled tasks with context control** — tasks support `context_mode`: `full` (default, keeps conversation history), `recent` (fresh window + last ~10 messages), or `none` (fully isolated)
- **Docker** — agent runs in an isolated container on Linux
- **Claude** — powered by Claude via Anthropic API

## Talking to Nova

Just send a message in Telegram — no trigger word needed.

Examples:
```
check the printer
is there anything interesting in my unread texts?
remind me every Monday morning to review open tasks
```

## Running

The service runs as a systemd user service and starts automatically on boot.

```bash
# Status
systemctl --user status nanoclaw

# Restart
systemctl --user restart nanoclaw

# Logs
tail -f logs/nanoclaw.log
```

## Deploy

Developed on the gaming PC (192.168.1.12), deployed to the homelab server (192.168.1.100).

```bash
# On .12 — after committing changes:
git push origin main

# On .100 — to deploy:
git pull && pnpm install && pnpm build
systemctl --user restart nanoclaw
```

Runtime state (`data/`, `groups/`, `.env`) lives only on .100 and is not in git.

## Based On

[nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) — a lightweight AI assistant framework. See the upstream README for full architecture documentation.

---

## Version History

### v2.0 — v1 port to v2 architecture

- **Telegram channel** — v2 Chat SDK bridge with pairing interceptor and outbound Markdown sanitizer
- **Matrix-SMS channel** — v1 SMS port via mautrix-gmessages bridge; SMS_READ_ONLY guard, MMS download via Matrix v1.11 auth endpoint, 1600-char split
- **Prusa MCP tool** — read-only printer status/job/files; PRUSA_URL + PRUSA_API_KEY forwarded host→container
- **context_mode for scheduled tasks** — `none`/`recent`/`full` field on task rows; maps from v1's `isolated`/`group` values
- **PDF reader** — container skill for text extraction from PDF attachments
- Forked from [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) at v2.0.54
