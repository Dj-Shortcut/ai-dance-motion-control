-- Prepared statement template, never concatenate untrusted values or secrets.
-- Bind: 1 Mollie TEST profile id; 2 exact HTTPS callback URL; 3 environment id;
-- 4 exact public origin; 5 exact Supabase project URL. One update only; the
-- caller must check meta.changes == 1 and independently verify all values.
UPDATE rig_closed_test_tenant SET mollie_profile=?1,webhook_url=?2
WHERE id=1 AND mode='test' AND environment_id=?3 AND public_origin=?4
  AND identity_project=?5 AND mollie_profile='' AND webhook_url='';
