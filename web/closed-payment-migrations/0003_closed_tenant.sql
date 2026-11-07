-- Must be provisioned only in a fresh, separate test database; no live data.
CREATE TABLE rig_closed_test_tenant (
  id INTEGER PRIMARY KEY CHECK(id=1),
  environment_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode='test'),
  public_origin TEXT NOT NULL,
  identity_project TEXT NOT NULL,
  mollie_profile TEXT NOT NULL,
  webhook_url TEXT NOT NULL
);
