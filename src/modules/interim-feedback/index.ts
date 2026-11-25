/**
 * Interim feedback — registration.
 *
 * Imported by the modules barrel for its side effects:
 *  - starts the "still working" check when the host starts, stops it on shutdown;
 *  - resets a session's delivery-failure notice count when a reply is delivered.
 *
 * The logic lives in ./nudge.ts and ./delivery-failure.ts.
 */
import { registerPostDeliveryHook } from '../../delivery.js';
import { onHostShutdown, onHostStart, type HostStartContext } from '../../host-lifecycle.js';
import { resetDeliveryFailureCount } from './delivery-failure.js';
import { startInterimFeedback, stopInterimFeedback } from './nudge.js';

export function startInterimFeedbackModule(ctx: HostStartContext): void {
  startInterimFeedback(ctx.deliveryAdapter);
}

onHostStart(startInterimFeedbackModule);
onHostShutdown(stopInterimFeedback);
registerPostDeliveryHook((_msg, session) => resetDeliveryFailureCount(session.id));
