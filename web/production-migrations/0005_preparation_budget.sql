-- An admitted media preparation is an attempt, never a refundable wallet cost.
-- No automatic deletion/release: failed and uncertain work stays counted.
CREATE TABLE rig_preparation_reservations (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 budget_day TEXT NOT NULL CHECK(length(budget_day)=10),
 bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 16777216),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0)
);
CREATE INDEX rig_preparation_user_day ON rig_preparation_reservations(budget_day,user_id);
