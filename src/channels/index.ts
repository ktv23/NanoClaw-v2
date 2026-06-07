// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';
// SMS (matrix-sms) intentionally disabled 2026-06-06 — v2 has no on-demand
// SMS-thread reading and Kevin asked to turn the integration off. Re-enable by
// uncommenting; the adapter still self-gates on MATRIX_* creds in .env.
// import './matrix-sms.js';
import './telegram.js';
