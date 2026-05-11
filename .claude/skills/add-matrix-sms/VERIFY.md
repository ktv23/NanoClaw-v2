# Verify Matrix-SMS

1. Have someone text the phone paired with Google Messages, or text the phone yourself from another device.
2. Tail `logs/nanoclaw.log` and look for `SMS: message received` with the platform_id `sms:<phone>`.
3. The router auto-creates a `messaging_groups` row on first inbound. Confirm with: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, name, channel_type, platform_id FROM messaging_groups WHERE channel_type = 'sms'"`.
4. Wire it to an agent group via `/manage-channels` (or `ncl wirings create ...`), reply, and check `SMS: message sent` in the log.

If `SMS: bridge DB not found` appears: set `GMESSAGES_DB` to the actual path. The adapter still works without it (lazy room discovery), but contact names won't populate.

If you see `Matrix sync failed`: the homeserver isn't reachable or the access token is wrong. Test with `curl -H "Authorization: Bearer $MATRIX_ACCESS_TOKEN" $MATRIX_URL/_matrix/client/v3/account/whoami`.
