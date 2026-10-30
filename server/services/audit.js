import { query } from '../db/pool.js';
import { iso } from '../lib/http.js';

export async function writeAudit(
  db,
  { actorId = null, action, entityType, entityId = null, details = null, ip = null },
) {
  const runner = db || { query };
  await runner.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, ip)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      actorId,
      action,
      entityType,
      entityId === null ? null : String(entityId),
      details === null ? null : JSON.stringify(details),
      ip,
    ],
  );
}

export function serializeAudit(row) {
  return {
    id: row.id,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    details: row.details,
    ip: row.ip,
    created_at: iso(row.created_at),
    actor: row.actor_id
      ? {
          id: row.actor_id,
          full_name: row.actor_full_name,
          email: row.actor_email,
          role: row.actor_role,
        }
      : null,
  };
}
