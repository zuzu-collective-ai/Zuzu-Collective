// Twilio SMS integration — fire-and-forget, no extra dependencies.
// Silently no-ops when TWILIO_* env vars are not set.

import { request } from 'node:https';
import { stringify } from 'node:querystring';

function sendSms({ to, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !from || !to) return;

  const payload = stringify({ To: to, From: from, Body: body });
  const auth    = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const req = request({
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
    },
  });
  req.on('error', (err) => console.error('[sms]', err.message));
  req.write(payload);
  req.end();
}

function fmtDollars(cents) {
  const d = (cents || 0) / 100;
  return '$' + d.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

async function runPaymentReminders(pool) {
  const notifyPhone = process.env.NOTIFY_PHONE;
  const twilioReady = process.env.TWILIO_ACCOUNT_SID &&
                      process.env.TWILIO_AUTH_TOKEN  &&
                      process.env.TWILIO_FROM_NUMBER;
  if (!twilioReady) return;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const inSevenDays = new Date(today.getTime() + 7 * 86400000);

  const { rows } = await pool.query(
    `select l.id, l.name, l.amount_cents, l.paid_cents, l.due_date,
            c.display_name as couple_name, c.couple_phone
       from budget_line_items l
       join budget_categories cat on cat.id = l.category_id
       join couples c on c.id = cat.couple_id
      where l.due_date is not null
        and l.status_kind != 'paid'
        and l.payment_sms_sent_at is null
        and l.due_date >= $1
        and l.due_date <= $2`,
    [today.toISOString().slice(0, 10), inSevenDays.toISOString().slice(0, 10)],
  );

  for (const p of rows) {
    const due      = new Date(p.due_date);
    due.setUTCHours(0, 0, 0, 0);
    const daysUntil  = Math.round((due - today) / 86400000);
    const balance    = Math.max(0, (p.amount_cents || 0) - (p.paid_cents || 0));
    const whenStr    = daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'} (${fmtDate(p.due_date)})`;

    if (notifyPhone) {
      sendSms({
        to: notifyPhone,
        body: `Zuzu Collective: Payment reminder — ${p.couple_name}'s "${p.name}" (${fmtDollars(balance)}) is due ${whenStr}.`,
      });
    }

    if (p.couple_phone) {
      sendSms({
        to: p.couple_phone,
        body: `Reminder from Zuzu Collective: Your "${p.name}" payment (${fmtDollars(balance)}) is due ${whenStr}. Questions? Reply here or email hello@zuzucollective.com.`,
      });
    }

    await pool.query(
      'update budget_line_items set payment_sms_sent_at = now() where id = $1',
      [p.id],
    );
  }
}

export function startPaymentReminderScheduler(pool) {
  const run = () => runPaymentReminders(pool).catch(
    (err) => console.error('[sms-scheduler]', err.message),
  );
  run();
  setInterval(run, 24 * 60 * 60 * 1000);
}
