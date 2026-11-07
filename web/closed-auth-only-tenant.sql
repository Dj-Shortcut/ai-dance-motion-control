-- Prepared for the separate RIG test D1 only. No Mollie secret or real money.
-- Existing tenant rows are never overwritten. If the actual public origin
-- changes, this file and RIG_PUBLIC_ORIGIN must be reviewed together.
INSERT INTO rig_closed_test_tenant
  (id,environment_id,mode,public_origin,identity_project,mollie_profile,webhook_url)
VALUES
  (1,'rig-public-test-v1','test',
   'https://rig-closed-test-ingress-v1.shortcut-computerguy.workers.dev',
   'https://fcpjgxerztaxlmfnzzsq.supabase.co','','');
