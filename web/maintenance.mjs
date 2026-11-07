// Internal, test-only maintenance. This module has no HTTP interface.
// The host invokes it through the private backend Worker's scheduled event.
import {cleanupExpiredNonces} from './gateway.mjs';
import {runCancellationBatch} from './cancel-scheduler.mjs';
import {runCancellationReconciliation} from './cancel-reconcile.mjs';
import {getConfig} from './payment.mjs';
import {monitorTestReversals} from './reversal-monitor.mjs';

export async function runTestMaintenance(env) {
  // Deployments are inert until an operator explicitly enables maintenance.
  if (env?.RIG_MAINTENANCE_ENABLED !== 'yes') return {enabled:false};
  if (env.RIG_MODE !== 'test' || env.RIG_MOLLIE_MODE !== 'test' ||
      env.RIG_MOLLIE_TEST_SCHEDULER_ENABLED !== 'yes' || !env.DB ||
      !/^test_[A-Za-z0-9]+$/.test(env.MOLLIE_API_KEY || '')) {
    throw Error('Test maintenance is not configured');
  }
  // Validate the complete payment configuration before attempting any cancel;
  // otherwise cancellation could succeed but reconciliation could never run.
  const config = getConfig(env);
  if (new URL(config.webhook).pathname !== '/api/payments/webhook') {
    throw Error('Test webhook configuration is not valid');
  }
  const dbMode = await env.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();
  if (dbMode?.mode !== 'test') throw Error('Test database required');
  // Never delete a nonce inside the signature validity window. The cleanup
  // implementation uses a five-minute safety window and a bounded batch.
  const cleaned = await cleanupExpiredNonces(env.DB);
  // These processors use durable, fenced leases and bounded per-run work.
  // An uncertain cancellation is held for manual review, never retried blindly.
  const cancellations = await runCancellationBatch({env});
  const reconciliation = await runCancellationReconciliation({env});
  const reversals = await monitorTestReversals({env});
  return {enabled:true,noncesRemoved:cleaned?.meta?.changes ?? 0,cancellations,reconciliation,reversals};
}
