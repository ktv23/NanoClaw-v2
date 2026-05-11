# Remove Matrix-SMS

1. Remove `import './matrix-sms.js';` from `src/channels/index.ts` (or comment it out).
2. Remove `MATRIX_URL`, `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`, `MATRIX_BRIDGE_BOT`, `GMESSAGES_DB`, and `SMS_READ_ONLY` from `.env` (and `data/env/env` if synced).
3. Optionally `pnpm uninstall matrix-js-sdk` if no other channel uses it.
4. Rebuild and restart:
   ```bash
   pnpm run build
   systemctl --user restart nanoclaw-v2-*    # Linux
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-*  # macOS
   ```

Existing `messaging_groups` rows with `channel_type = 'sms'` stay in the DB — delete them by hand if you want a clean slate (`ncl messaging-groups delete --id ...`).

The bridge itself (mautrix-gmessages) is independent of NanoClaw — leave it running or shut it down separately.
