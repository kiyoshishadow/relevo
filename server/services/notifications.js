import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { iso } from '../lib/http.js';

/**
 * Encola una notificación en la misma transacción que la acción de negocio.
 * El envío real ocurre después (dispatcher o scripts/notifications-drain.js).
 */
export async function enqueueNotification(
  db,
  { caseId = null, recipient, template, subject, body },
) {
  if (!recipient) return null;
  const { rows } = await db.query(
    `INSERT INTO notification_outbox (case_id, recipient, template, subject, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [caseId, recipient, template, subject, body],
  );
  return rows[0].id;
}

export async function notifyCase(db, caseRow, { template, subject, body }) {
  if (!caseRow?.client_email) return null;
  return enqueueNotification(db, {
    caseId: caseRow.id,
    recipient: caseRow.client_email,
    template,
    subject,
    body,
  });
}

export function serializeNotification(row, { includeBody = true } = {}) {
  return {
    id: row.id,
    case_id: row.case_id,
    case_number: row.case_number || null,
    recipient: row.recipient,
    channel: row.channel,
    template: row.template,
    subject: row.subject,
    ...(includeBody ? { body: row.body } : {}),
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    provider: row.provider,
    created_at: iso(row.created_at),
    next_attempt_at: iso(row.next_attempt_at),
    sent_at: iso(row.sent_at),
  };
}

async function deliverLocal(row) {
  const payload = {
    event: 'notification.local',
    id: row.id,
    to: row.recipient,
    subject: row.subject,
    body: row.body,
    case_id: row.case_id,
    created_at: new Date().toISOString(),
  };
  console.log(JSON.stringify(payload));
  if (config.notificationsLocalFile) {
    const target = resolve(process.cwd(), config.notificationsLocalFile);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(payload)}\n`, 'utf8');
  }
  return { provider: 'local-console' };
}

let smtpTransport = null;
async function deliverSmtp(row) {
  if (!smtpTransport) {
    const nodemailer = await import('nodemailer');
    smtpTransport = nodemailer.default.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.password }
        : undefined,
    });
  }
  await smtpTransport.sendMail({
    from: config.smtp.from,
    to: row.recipient,
    subject: row.subject,
    text: row.body,
  });
  return { provider: 'smtp' };
}

async function deliver(row) {
  if (config.notificationsMode === 'smtp') return deliverSmtp(row);
  return deliverLocal(row);
}

/**
 * Procesa la bandeja. Usa FOR UPDATE SKIP LOCKED y marca 'sending' antes de
 * liberar la transacción, de modo que dos workers no envíen la misma fila.
 * Los mensajes en 'sending' demasiado antiguos se recuperan.
 */
export async function processOutbox({ limit = 25 } = {}) {
  await query(
    `UPDATE notification_outbox
        SET status = 'pending', updated_at = now()
      WHERE status = 'sending' AND updated_at < now() - interval '10 minutes'`,
  );

  const claimed = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT o.*, c.case_number
         FROM notification_outbox o
         LEFT JOIN cases c ON c.id = o.case_id
        WHERE o.status = 'pending' AND o.next_attempt_at <= now()
        ORDER BY o.id
        LIMIT $1
        FOR UPDATE OF o SKIP LOCKED`,
      [limit],
    );
    if (rows.length > 0) {
      await client.query(
        `UPDATE notification_outbox
            SET status = 'sending', updated_at = now()
          WHERE id = ANY($1::bigint[])`,
        [rows.map((row) => row.id)],
      );
    }
    return rows;
  });

  const result = { claimed: claimed.length, sent: 0, failed: 0 };
  for (const row of claimed) {
    try {
      const { provider } = await deliver(row);
      await query(
        `UPDATE notification_outbox
            SET status = 'sent', attempts = attempts + 1, provider = $2,
                last_error = NULL, updated_at = now(), sent_at = now()
          WHERE id = $1`,
        [row.id, provider],
      );
      result.sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const finalFailure = attempts >= 5;
      const backoffSeconds = Math.min(3600, 30 * 2 ** Math.min(attempts, 6));
      await query(
        `UPDATE notification_outbox
            SET status = $2, attempts = $3, last_error = $4, updated_at = now(),
                next_attempt_at = now() + ($5::int * interval '1 second')
          WHERE id = $1`,
        [row.id, finalFailure ? 'failed' : 'pending', attempts, String(error.message), backoffSeconds],
      );
      result.failed += 1;
      console.error(
        JSON.stringify({
          event: 'notification.delivery_failed',
          id: row.id,
          attempts,
          final: finalFailure,
          message: error.message,
        }),
      );
    }
  }
  return result;
}

export function startNotificationDispatcher() {
  if (!config.notificationsAutoProcess) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await processOutbox();
      if (result.claimed > 0) {
        console.log(JSON.stringify({ event: 'notification.batch', ...result }));
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'notification.dispatcher_error', message: error.message }));
    } finally {
      running = false;
    }
  }, config.notificationsIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
