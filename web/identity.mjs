// Internal building block only: this does not verify tokens or expose a route.
// A server-side verifier MUST validate signature, issuer, audience, expiry and
// the provider's full authentication requirements before returning claims.

function validText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Map a verified provider subject to one RIG account; never use email as ID. */
export async function resolveVerifiedAccount(db, claims, expectedIssuer) {
  if (!db || typeof db.prepare !== 'function' || !validText(expectedIssuer, 2048)
      || !claims || claims.iss !== expectedIssuer || !validText(claims.sub, 255)) {
    throw new Error('Invalid verified identity');
  }

  // The unique pair and INSERT OR IGNORE make concurrent first logins safe.
  // IDs are server-created; no email address or caller-supplied user ID is used.
  const accountId = `u-${crypto.randomUUID()}`;
  await db.prepare(`INSERT OR IGNORE INTO rig_external_identities
    (issuer, subject, user_id) VALUES (?, ?, ?)`)
    .bind(expectedIssuer, claims.sub, accountId).run();
  const row = await db.prepare(`SELECT user_id FROM rig_external_identities
    WHERE issuer = ? AND subject = ?`)
    .bind(expectedIssuer, claims.sub).first();
  if (!row || typeof row.user_id !== 'string' || !/^u-[0-9a-f-]{36}$/.test(row.user_id)) {
    throw new Error('Could not resolve identity');
  }
  return row.user_id;
}
