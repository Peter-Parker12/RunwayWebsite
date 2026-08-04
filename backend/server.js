const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const multer = require('multer');

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

async function ensureSchema() {
  await pool.query(`
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
  `);

  // New submissions no longer collect an arrival time — relax the constraint.
  // Existing rows keep their values; this only changes future-insert validation.
  await pool.query(`ALTER TABLE rsvps ALTER COLUMN arrival DROP NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wishlist_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      claimed_by_rsvp_id INTEGER REFERENCES rsvps(id),
      claimed_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    INSERT INTO wishlist_items (name) VALUES
      ('Ổ chuyển đổi cho MacBook'),
      ('Ổ cắm điện Deli 4 ổ, dây 3m'),
      ('Bộ sạc và pin AA Eneloop Panasonic'),
      ('Sạc dự phòng Baseus 22.5W 20000mAh'),
      ('Headphone'),
      ('Khóa vali có số (để khóa vali đi tàu EU)'),
      ('AirTag (x2)'),
      ('Vòi xịt cầm tay'),
      ('Xịt mạt bụi'),
      ('Paw Paw Lucas dưỡng môi'),
      ('Vitamin C sủi'),
      ('Thước kẻ be bé'),
      ('Ô (dù)'),
      ('Bùa bình an dán vali'),
      ('Bông tẩy trang'),
      ('Sữa rửa mặt Roundlab'),
      ('Thuốc nhỏ mắt Rothko'),
      ('Lọ cồn xịt (khử trùng)'),
      ('Bàn là mini'),
      ('Gia vị Việt Nam'),
      ('Tương ớt Chinsu (size nhỏ)'),
      ('Tương ớt Chinsu (size nhỡ)')
    ON CONFLICT (name) DO NOTHING
  `);

  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS attending BOOLEAN NOT NULL DEFAULT true`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS note TEXT`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS photo_path TEXT`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS voice_path TEXT`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS gift_type TEXT`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS wishlist_item_id INTEGER REFERENCES wishlist_items(id)`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS public_token TEXT`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS rsvps_public_token_idx
      ON rsvps(public_token) WHERE public_token IS NOT NULL
  `);
}
ensureSchema().catch(err => console.error('Failed to ensure schema', err));

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PHOTO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const VOICE_EXT = { 'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg' };

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const baseMime = file.mimetype.split(';')[0].trim();
    const ext = PHOTO_EXT[baseMime] || VOICE_EXT[baseMime] || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const baseMime = file.mimetype.split(';')[0].trim();
    if (file.fieldname === 'photo' && !PHOTO_EXT[baseMime]) return cb(new Error('INVALID_PHOTO_TYPE'));
    if (file.fieldname === 'voice' && !VOICE_EXT[baseMime]) return cb(new Error('INVALID_VOICE_TYPE'));
    cb(null, true);
  },
});

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

app.post('/api/rsvp', (req, res, next) => {
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'voice', maxCount: 1 }])(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Invalid or oversized file upload' });
    next();
  });
}, async (req, res) => {
  const fullname = String(req.body?.fullname || '').trim().slice(0, MAX_FIELD_LEN);
  const email = String(req.body?.email || '').trim().slice(0, MAX_FIELD_LEN);
  const attending = req.body?.attending === 'true';

  if (!fullname || !email) {
    return res.status(400).json({ error: 'Full name and email are required' });
  }

  const note = attending ? null : String(req.body?.note || '').trim().slice(0, MAX_MESSAGE_LEN);
  const photoPath = req.files?.photo?.[0]?.filename || null;
  const voicePath = req.files?.voice?.[0]?.filename || null;
  const publicToken = crypto.randomUUID();

  let rsvpId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO rsvps (fullname, email, attending, note, photo_path, voice_path, public_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [fullname, email, attending, note, photoPath, voicePath, publicToken]
    );
    rsvpId = rows[0].id;
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to save RSVP' });
  }

  if (transporter) {
    const attachments = [];
    if (photoPath) attachments.push({ filename: photoPath, path: path.join(UPLOAD_DIR, photoPath) });
    if (voicePath) attachments.push({ filename: voicePath, path: path.join(UPLOAD_DIR, voicePath) });

    transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.RSVP_TO,
      replyTo: email,
      subject: `TIDE RSVP — ${fullname} (${attending ? 'Attending' : 'Not attending'})`,
      text: attending
        ? [`Name: ${fullname}`, `Email: ${email}`, `Status: Attending`].join('\n')
        : [
            `Name: ${fullname}`,
            `Email: ${email}`,
            `Note: ${note || '(none)'}`,
            `Photo attached: ${photoPath ? 'yes' : 'no'}`,
            `Voice message attached: ${voicePath ? 'yes' : 'no'}`,
          ].join('\n'),
      attachments,
    }).catch(err => console.error('Failed to send RSVP notification email', err));
  }

  res.status(201).json({ ok: true, id: rsvpId, token: publicToken });
});

app.get('/api/wishlist', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { rows } = await pool.query(
      `SELECT id, name, (claimed_by_rsvp_id IS NOT NULL) AS claimed FROM wishlist_items ORDER BY id`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load wishlist' });
  }
});

app.post('/api/wishlist/:id/claim', async (req, res) => {
  const itemId = Number(req.params.id);
  const token = String(req.body?.token || '').trim();
  if (!Number.isInteger(itemId) || !token) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: rsvpRows } = await client.query('SELECT id, fullname, email FROM rsvps WHERE public_token=$1', [token]);
    if (!rsvpRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'RSVP not found' });
    }
    const rsvp = rsvpRows[0];

    const claim = await client.query(
      `UPDATE wishlist_items SET claimed_by_rsvp_id=$1, claimed_at=now()
       WHERE id=$2 AND claimed_by_rsvp_id IS NULL RETURNING id, name`,
      [rsvp.id, itemId]
    );
    if (claim.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This gift has already been claimed.' });
    }

    await client.query('UPDATE rsvps SET gift_type=$1, wishlist_item_id=$2 WHERE id=$3', ['wishlist', itemId, rsvp.id]);
    await client.query('COMMIT');

    if (transporter) {
      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.RSVP_TO,
        subject: `TIDE Gift Claimed — ${claim.rows[0].name}`,
        text: `${rsvp.fullname} (${rsvp.email}) just claimed "${claim.rows[0].name}" from the wishlist.`,
      }).catch(err => console.error('Failed to send wishlist claim email', err));
    }

    res.json({ id: claim.rows[0].id, name: claim.rows[0].name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to claim gift' });
  } finally {
    client.release();
  }
});

app.listen(port, () => {
  console.log(`Tide server listening on :${port}`);
});
