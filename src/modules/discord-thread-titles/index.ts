/**
 * Discord thread titles — registration.
 *
 * Imported by the modules barrel for its side effect: it puts the rename on
 * the router's session-created hook. The logic lives in ./rename.ts.
 */
import { registerSessionCreatedHook } from '../../router.js';
import { nameSpawnedDiscordThread } from './rename.js';

registerSessionCreatedHook(nameSpawnedDiscordThread);
