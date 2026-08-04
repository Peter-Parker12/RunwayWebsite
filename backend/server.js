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

  // One RSVP per email — resubmitting with the same email updates the
  // existing row (see POST /api/rsvp) instead of creating a duplicate.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS rsvps_email_idx ON rsvps(email)`);
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

// Event is 18:26–21:45 Vietnam time (ICT, UTC+7) on Aug 14th 2026 = 11:26–14:45 UTC.
const EVENT_DTSTART_UTC = '20260814T112600Z';
const EVENT_DTEND_UTC = '20260814T144500Z';
const EVENT_LOCATION = 'Số 23, ngách 309/16 đường Nguyễn Đức Thuận, Gia Lâm, Hà Nội';
const SITE_URL = 'https://tide.erasight.net';

// A guest's public_token is their only "login" — this link is how they get
// back to manage their RSVP/gift after closing the tab or clearing local
// storage, without needing an account or password.
function manageLink(token) {
  return `${SITE_URL}/invitation-box.html?token=${encodeURIComponent(token)}`;
}

function icsEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

function buildInviteIcs({ uid, guestName }) {
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TIDE//Hamvcl//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${EVENT_DTSTART_UTC}`,
    `DTEND:${EVENT_DTEND_UTC}`,
    'SUMMARY:TIDE — A Private Runway & Gathering',
    `DESCRIPTION:${icsEscape(`You're invited, ${guestName}. A private runway and gathering hosted by Hamvcl.`)}`,
    `LOCATION:${icsEscape(EVENT_LOCATION)}`,
    `ORGANIZER;CN=TIDE:MAILTO:${process.env.SMTP_USER || 'noreply@example.com'}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

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

  let arrival = null, transport = null;
  const note = String(req.body?.note || '').trim().slice(0, MAX_MESSAGE_LEN);
  const photoPath = req.files?.photo?.[0]?.filename || null;
  const voicePath = req.files?.voice?.[0]?.filename || null;

  if (attending) {
    arrival = String(req.body?.arrival || '').trim().slice(0, MAX_FIELD_LEN);
    if (!arrival) return res.status(400).json({ error: 'Arrival time is required' });
    transport = String(req.body?.transport || '').trim().slice(0, MAX_FIELD_LEN);
  }

  const giftChoice = String(req.body?.giftChoice || '').trim(); // 'contribute' | 'wishlist' | ''
  const wishlistItemId = giftChoice === 'wishlist' ? Number(req.body?.wishlistItemId) : null;

  const newToken = crypto.randomUUID();

  let rsvpId, publicToken, isUpdate, giftName = null, giftConflict = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO rsvps (fullname, email, attending, arrival, transport, note, photo_path, voice_path, public_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (email) DO UPDATE SET
         fullname=EXCLUDED.fullname, attending=EXCLUDED.attending, arrival=EXCLUDED.arrival,
         transport=EXCLUDED.transport, note=EXCLUDED.note, photo_path=EXCLUDED.photo_path,
         voice_path=EXCLUDED.voice_path
       RETURNING id, public_token, wishlist_item_id, (xmax <> 0) AS is_update`,
      [fullname, email, attending, arrival, transport, note, photoPath, voicePath, newToken]
    );
    rsvpId = rows[0].id;
    publicToken = rows[0].public_token;
    isUpdate = rows[0].is_update;
    let existingWishlistItemId = rows[0].wishlist_item_id;

    if (giftChoice === 'contribute') {
      await client.query('UPDATE rsvps SET gift_type=$1 WHERE id=$2', ['contribute', rsvpId]);
    } else if (giftChoice === 'wishlist' && Number.isInteger(wishlistItemId)) {
      const claim = await client.query(
        `UPDATE wishlist_items SET claimed_by_rsvp_id=$1, claimed_at=now()
         WHERE id=$2 AND claimed_by_rsvp_id IS NULL RETURNING id, name`,
        [rsvpId, wishlistItemId]
      );
      if (claim.rowCount > 0) {
        await client.query('UPDATE rsvps SET gift_type=$1, wishlist_item_id=$2 WHERE id=$3', ['wishlist', wishlistItemId, rsvpId]);
        giftName = claim.rows[0].name;
        existingWishlistItemId = wishlistItemId;
      } else {
        giftConflict = true; // someone else claimed it in the same instant — RSVP still succeeds
      }
    }

    await client.query('COMMIT');

    // Surface whatever gift is actually attached to this RSVP (from this
    // submission, or a prior one — claiming is otherwise its own action).
    if (!giftName && existingWishlistItemId) {
      const { rows: itemRows } = await pool.query('SELECT name FROM wishlist_items WHERE id=$1', [existingWishlistItemId]);
      giftName = itemRows[0]?.name || null;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    return res.status(500).json({ error: 'Failed to save RSVP' });
  } finally {
    client.release();
  }

  if (transporter) {
    const attachments = [];
    if (photoPath) attachments.push({ filename: photoPath, path: path.join(UPLOAD_DIR, photoPath) });
    if (voicePath) attachments.push({ filename: voicePath, path: path.join(UPLOAD_DIR, voicePath) });

    const giftLine = giftName ? `Gift: ${giftName}` : giftChoice === 'contribute' ? 'Gift: Intends to contribute' : 'Gift: Not selected yet';

    transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.RSVP_TO,
      replyTo: email,
      subject: `TIDE RSVP ${isUpdate ? 'Updated' : ''} — ${fullname} (${attending ? 'Attending' : 'Not attending'})`,
      text: [
        `Name: ${fullname}`,
        `Email: ${email}`,
        `Status: ${attending ? `Attending (arrival ${arrival}, transport: ${transport || 'not specified'})` : 'Not attending'}`,
        `Note: ${note || '(none)'}`,
        `Photo attached: ${photoPath ? 'yes' : 'no'}`,
        `Voice message attached: ${voicePath ? 'yes' : 'no'}`,
        giftLine,
      ].join('\n'),
      attachments,
    }).catch(err => console.error('Failed to send RSVP notification email', err));

    const giftLineForGuest = giftName
      ? `You've claimed "${giftName}" from the wishlist — thank you!`
      : giftConflict
      ? "The gift you picked was just claimed by someone else — use the link below to pick another."
      : giftChoice === 'contribute'
      ? 'Thank you for wanting to contribute to the journey!'
      : null;

    if (attending) {
      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: email,
        subject: `You're invited: TIDE — A Private Runway & Gathering`,
        text: [
          `Hi ${fullname},`,
          '',
          `Thank you for confirming — we can't wait to see you on August 14th, 2026 at ${arrival}.`,
          '',
          `Venue: ${EVENT_LOCATION}`,
          '',
          'A calendar invite is attached.',
          '',
          giftLineForGuest,
          giftLineForGuest ? '' : null,
          `Want to change your RSVP or manage a gift later? Use this link anytime: ${manageLink(publicToken)}`,
          '',
          '— TIDE',
        ].filter(line => line !== null).join('\n'),
        icalEvent: {
          filename: 'invite.ics',
          method: 'PUBLISH',
          content: buildInviteIcs({ uid: `rsvp-${rsvpId}@tide.erasight.net`, guestName: fullname }),
        },
      }).catch(err => console.error('Failed to send guest calendar invite', err));
    } else {
      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: email,
        subject: `TIDE — We received your message`,
        text: [
          `Hi ${fullname},`,
          '',
          "Thank you for letting us know, and for the message you left — it means a lot.",
          '',
          giftLineForGuest,
          giftLineForGuest ? '' : null,
          `Want to update your RSVP or manage a gift later? Use this link anytime: ${manageLink(publicToken)}`,
          '',
          '— TIDE',
        ].filter(line => line !== null).join('\n'),
      }).catch(err => console.error('Failed to send guest confirmation email', err));
    }
  }

  res.status(201).json({ ok: true, id: rsvpId, token: publicToken, updated: isUpdate, giftConflict, giftName });
});

app.get('/api/wishlist', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = String(req.query?.token || '').trim();
  try {
    let myRsvpId = null;
    if (token) {
      const { rows } = await pool.query('SELECT id FROM rsvps WHERE public_token=$1', [token]);
      myRsvpId = rows[0]?.id || null;
    }
    const { rows } = await pool.query(
      `SELECT id, name, (claimed_by_rsvp_id IS NOT NULL) AS claimed,
              (claimed_by_rsvp_id = $1) AS "claimedByYou"
       FROM wishlist_items ORDER BY id`,
      [myRsvpId]
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

      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: rsvp.email,
        subject: `TIDE — You've claimed "${claim.rows[0].name}"`,
        text: [
          `Hi ${rsvp.fullname},`,
          '',
          `You've claimed "${claim.rows[0].name}" from the wishlist. Thank you!`,
          '',
          `Changed your mind? You can update your choice anytime here: ${manageLink(token)}`,
          '',
          '— TIDE',
        ].join('\n'),
      }).catch(err => console.error('Failed to send claim confirmation email', err));
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

app.post('/api/wishlist/:id/release', async (req, res) => {
  const itemId = Number(req.params.id);
  const token = String(req.body?.token || '').trim();
  if (!Number.isInteger(itemId) || !token) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: rsvpRows } = await client.query('SELECT id FROM rsvps WHERE public_token=$1', [token]);
    if (!rsvpRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'RSVP not found' });
    }
    const rsvp = rsvpRows[0];

    const release = await client.query(
      `UPDATE wishlist_items SET claimed_by_rsvp_id=NULL, claimed_at=NULL
       WHERE id=$1 AND claimed_by_rsvp_id=$2 RETURNING id, name`,
      [itemId, rsvp.id]
    );
    if (release.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You have not claimed this gift.' });
    }

    await client.query('UPDATE rsvps SET gift_type=NULL, wishlist_item_id=NULL WHERE id=$1 AND wishlist_item_id=$2', [rsvp.id, itemId]);
    await client.query('COMMIT');

    res.json({ id: release.rows[0].id, name: release.rows[0].name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to release gift' });
  } finally {
    client.release();
  }
});

app.listen(port, () => {
  console.log(`Tide server listening on :${port}`);
});
