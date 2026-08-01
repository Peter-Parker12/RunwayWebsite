const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

const mailEnabled = !!(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.RSVP_TO);
const transporter = mailEnabled
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

if (!mailEnabled) {
  console.warn('SMTP_USER / SMTP_PASS / RSVP_TO not set — RSVP emails are disabled, submissions will still be saved.');
}

const MAX_NAME_LEN = 60;
const MAX_MESSAGE_LEN = 500;
const MAX_FIELD_LEN = 200;

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

pool.query(`
  CREATE TABLE IF NOT EXISTS rsvps (
    id SERIAL PRIMARY KEY,
    fullname TEXT NOT NULL,
    arrival TEXT NOT NULL,
    allergy TEXT,
    transport TEXT,
    email TEXT NOT NULL,
    channels TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`).catch(err => console.error('Failed to ensure rsvps table', err));

app.get('/api/messages', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, message, created_at AS date FROM messages ORDER BY created_at DESC LIMIT 200'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.post('/api/messages', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, MAX_NAME_LEN);
  const message = String(req.body?.message || '').trim().slice(0, MAX_MESSAGE_LEN);
  if (!name || !message) {
    return res.status(400).json({ error: 'Name and message are required' });
  }

  try {
    const { rows } = await pool.query(
      'INSERT INTO messages (name, message) VALUES ($1, $2) RETURNING name, message, created_at AS date',
      [name, message]
    );
    res.status(201).json({ entry: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

app.post('/api/rsvp', async (req, res) => {
  const fullname = String(req.body?.fullname || '').trim().slice(0, MAX_FIELD_LEN);
  const arrival = String(req.body?.arrival || '').trim().slice(0, MAX_FIELD_LEN);
  const allergy = String(req.body?.allergy || '').trim().slice(0, MAX_FIELD_LEN);
  const transport = String(req.body?.transport || '').trim().slice(0, MAX_FIELD_LEN);
  const email = String(req.body?.email || '').trim().slice(0, MAX_FIELD_LEN);
  const channels = Array.isArray(req.body?.channels)
    ? req.body.channels.map(c => String(c).trim().slice(0, 40)).filter(Boolean).slice(0, 10)
    : [];

  if (!fullname || !arrival || !email) {
    return res.status(400).json({ error: 'Full name, arrival time, and email are required' });
  }

  try {
    await pool.query(
      `INSERT INTO rsvps (fullname, arrival, allergy, transport, email, channels)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fullname, arrival, allergy, transport, email, channels]
    );
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to save RSVP' });
  }

  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.RSVP_TO,
        replyTo: email,
        subject: `TIDE RSVP — ${fullname}`,
        text: [
          `Name: ${fullname}`,
          `Arrival: ${arrival}`,
          `Allergies: ${allergy || 'None specified'}`,
          `Transport: ${transport || 'Not specified'}`,
          `Email: ${email}`,
          `Invitation card via: ${channels.length ? channels.join(', ') : 'Not specified'}`,
        ].join('\n'),
      });
    } catch (err) {
      console.error('Failed to send RSVP notification email', err);
      // The RSVP is already saved — don't fail the request just because email delivery failed.
    }
  }

  res.status(201).json({ ok: true });
});

app.listen(port, () => {
  console.log(`Tide server listening on :${port}`);
});
