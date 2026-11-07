// Coarse shared budget for local experiments. The single global bucket bounds
// work before calling Supabase and before identity lookup. Do not trust a
// client-supplied IP header; production requires a separate trusted edge limit.
export async function preAuthLimit(db, now = Date.now(), limit = 60) {
  if (!db || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw Error('Invalid rate limiter configuration');
  }
  const row = await db.prepare(`INSERT INTO rig_public_auth_rate(scope, window_start, requests)
    VALUES ('global', ?, 1)
    ON CONFLICT(scope) DO UPDATE SET
      requests = CASE WHEN window_start <= ? THEN 1 ELSE requests + 1 END,
      window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
    WHERE window_start <= ? OR requests < ?
    RETURNING requests`).bind(now,now-60000,now-60000,now-60000,limit).first();
  if (!row) return false;
  if (!Number.isSafeInteger(row.requests) || row.requests < 1 || row.requests > limit) throw Error('Invalid rate limiter result');
  return true;
}
