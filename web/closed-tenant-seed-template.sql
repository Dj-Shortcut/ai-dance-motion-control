-- Template only. Bind five validated non-secret values using a prepared
-- statement. Never interpolate user input. Never insert or change a secret.
-- 1 environment ID, 2 exact public origin, 3 exact identity project URL,
-- 4 Mollie TEST profile ID, 5 exact webhook URL. Existing row is never updated.
INSERT INTO rig_closed_test_tenant
  (id,environment_id,mode,public_origin,identity_project,mollie_profile,webhook_url)
VALUES (1,?1,'test',?2,?3,?4,?5);
