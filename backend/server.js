const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

// Note: host (Hai) is no longer emailed on every RSVP/claim — new entries
// are logged to a Google Sheet instead (see logRsvpToSheet/logClaimToSheet).
// This transporter now only sends guest-facing emails (confirmation,
// calendar invite, claim confirmation).
const mailEnabled = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
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
  console.warn('SMTP_USER / SMTP_PASS not set — guest emails are disabled, submissions will still be saved.');
}

// Every RSVP submission and gift claim/release gets appended as a row —
// this is Hai's primary view into new entries now (replaces host emails).
const GOOGLE_CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Sheet1';
// Quoted for use in A1-notation ranges — required whenever the tab name
// contains a space (e.g. "Gift Tracking"), harmless otherwise.
const SHEET_TAB_REF = `'${GOOGLE_SHEET_TAB.replace(/'/g, "''")}'`;

const sheetsEnabled = !!(GOOGLE_CREDENTIALS_PATH && GOOGLE_SHEET_ID && fs.existsSync(GOOGLE_CREDENTIALS_PATH));
const sheetsClient = sheetsEnabled
  ? google.sheets({
      version: 'v4',
      auth: new google.auth.GoogleAuth({
        keyFile: GOOGLE_CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      }),
    })
  : null;

if (!sheetsEnabled) {
  console.warn('GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_SHEET_ID not set — Sheet logging is disabled, submissions will still be saved.');
}

function parseSheetRowNumber(updatedRange) {
  // e.g. "Sheet1!A38:L38" -> 38
  const m = /![A-Z]+(\d+)/.exec(updatedRange || '');
  return m ? Number(m[1]) : null;
}

// Returns the 1-indexed sheet row the entry landed on, so a later gift
// claim/release can update that same row instead of appending a new one.
async function appendSheetRow(row) {
  if (!sheetsClient) return null;
  try {
    const res = await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_TAB_REF}!A:L`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    return parseSheetRowNumber(res.data?.updates?.updatedRange);
  } catch (err) {
    console.error('Failed to log to Google Sheet', err.message);
    return null;
  }
}

// Column K is "Gift" in the A:L header layout (see appendSheetRow's row shape).
async function updateSheetGiftCell(sheetRow, giftValue) {
  if (!sheetsClient || !sheetRow) return false;
  try {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_TAB_REF}!K${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[giftValue]] },
    });
    return true;
  } catch (err) {
    console.error('Failed to update Google Sheet gift cell', err.message);
    return false;
  }
}

// Overwrites a guest's whole row in place (used when they resubmit their RSVP).
async function updateSheetRow(sheetRow, values) {
  if (!sheetsClient || !sheetRow) return false;
  try {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_TAB_REF}!A${sheetRow}:L${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });
    return true;
  } catch (err) {
    console.error('Failed to update Google Sheet row', err.message);
    return false;
  }
}

// A guest can hold any number of wishlist items plus an independent
// "intends to contribute" flag — this is the one place that turns that
// state into the single human-readable string shown in the sheet's Gift
// column and in guest emails.
async function computeGiftSummary(rsvpId) {
  const { rows } = await pool.query(
    `SELECT gift_type,
            (SELECT array_agg(name ORDER BY id) FROM wishlist_items WHERE claimed_by_rsvp_id=$1) AS items
     FROM rsvps WHERE id=$1`,
    [rsvpId]
  );
  const items = rows[0]?.items || [];
  const parts = [];
  if (rows[0]?.gift_type === 'contribute') parts.push('Intends to contribute');
  if (items.length) parts.push(items.join(', '));
  return { summary: parts.join(' + '), items };
}

// Self-heals rsvps.sheet_row for guests who RSVP'd/claimed before this
// column existed — looks up their most recent row by email so we can start
// updating in place instead of appending.
async function findSheetRowByEmail(email) {
  if (!sheetsClient) return null;
  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_TAB_REF}!D:D`,
    });
    const values = res.data.values || [];
    const target = email.trim().toLowerCase();
    for (let i = values.length - 1; i >= 0; i--) {
      if ((values[i][0] || '').trim().toLowerCase() === target) return i + 1;
    }
    return null;
  } catch (err) {
    console.error('Failed to look up sheet row by email', err.message);
    return null;
  }
}

// A tracked sheet_row can go stale if someone edits the sheet by hand
// (deleting/reordering rows) — confirm the row still belongs to this email
// before trusting it, so a resubmit/claim never silently overwrites a
// different guest's line.
async function sheetRowMatchesEmail(sheetRow, email) {
  if (!sheetsClient || !sheetRow) return false;
  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_TAB_REF}!D${sheetRow}`,
    });
    const cell = res.data.values?.[0]?.[0] || '';
    return cell.trim().toLowerCase() === email.trim().toLowerCase();
  } catch (err) {
    console.error('Failed to verify sheet row email', err.message);
    return false;
  }
}

// One row per guest, no duplicates: reuses a tracked sheet_row once it's
// been verified to still point at this guest's row, otherwise re-finds it
// by email (or returns null, meaning: never logged / no longer present,
// caller should append a fresh row).
async function resolveSheetRow(rsvpId, email, knownSheetRow) {
  if (knownSheetRow && await sheetRowMatchesEmail(knownSheetRow, email)) {
    return knownSheetRow;
  }
  const found = await findSheetRowByEmail(email);
  if (found !== knownSheetRow) {
    pool.query('UPDATE rsvps SET sheet_row=$1 WHERE id=$2', [found, rsvpId])
      .catch(err => console.error('Failed to persist sheet_row', err.message));
  }
  return found;
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
      category TEXT,
      brand TEXT,
      referral_link TEXT,
      claimed_by_rsvp_id INTEGER REFERENCES rsvps(id),
      claimed_at TIMESTAMPTZ
    )
  `);
  await pool.query(`ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS category TEXT`);
  await pool.query(`ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS brand TEXT`);
  await pool.query(`ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS referral_link TEXT`);

  // Renames items already seeded under an older name/wording to the current
  // wording below — done as UPDATEs (not delete+reinsert) so id and any
  // existing claimed_by_rsvp_id survive the rename.
  await pool.query(`
    UPDATE wishlist_items SET name = v.new_name FROM (VALUES
      ('Ổ chuyển đổi cho MacBook', 'Ổ chuyển đổi cho macbook'),
      ('Ổ cắm điện Deli 4 ổ, dây 3m', 'Ổ cắm điện Deli 4 ổ 4 nguồn dây 3m'),
      ('Bộ sạc và pin AA Eneloop Panasonic', 'Bộ sạc và pin AA eneloop panasonic'),
      ('Sạc dự phòng Baseus 22.5W 20000mAh', 'sạc dự phòng - baseus, 22.5W, 20000mAh'),
      ('Headphone', 'headphone'),
      ('Khóa vali có số (để khóa vali đi tàu EU)', 'khóa dây có số (để khóa vali nếu đi tàu EU)'),
      ('Vòi xịt cầm tay', 'vòi xịt cầm tay'),
      ('Xịt mạt bụi', 'xịt mạt bụi'),
      ('Paw Paw Lucas dưỡng môi', 'paw paw lucas dưỡng môi'),
      ('Vitamin C sủi', 'C sủi'),
      ('Ô (dù)', 'ô (dù)'),
      ('Bông tẩy trang', 'bông tẩy trang'),
      ('Sữa rửa mặt Roundlab', 'sữa rửa mặt roundlab'),
      ('Thuốc nhỏ mắt Rothko', 'thuốc nhỏ mắt rothko'),
      ('Bàn là mini', 'bàn là mini'),
      ('Gia vị Việt Nam', 'Gia vị việt nam'),
      ('Tương ớt Chinsu (size nhỏ)', 'tương ớt chinsu size nhỏ +1 (nhỡ)')
    ) AS v(old_name, new_name)
    WHERE wishlist_items.name = v.old_name
  `);

  // Upsert current name/category/brand/referral_link — matches by name (after
  // the rename pass above), so this only ever updates existing rows in place
  // or inserts genuinely new items; it never touches claimed_by_rsvp_id.
  await pool.query(`
    INSERT INTO wishlist_items (name, category, brand, referral_link) VALUES
      ('Ổ chuyển đổi cho macbook', 'e-device', NULL, 'https://shopee.vn/product/325696535/10389130208?d_id=7d992&uls_trackid=569unu0f00hu&utm_content=2KJLrQm9NF2owUgL4AEM3cPueQQ7'),
      ('Ổ cắm điện Deli 4 ổ 4 nguồn dây 3m', 'e-device', 'Deli', 'https://shopee.vn/product/347048079/23534075464?d_id=7d992&uls_trackid=569unt3601sa&utm_content=2KJLrQm9NFBrngVdnJcBJc7a7iUX'),
      ('Bộ sạc và pin AA eneloop panasonic', 'e-device', NULL, 'https://shopee.vn/product/1694770608/50954898414?d_id=7d992&uls_trackid=569unuok02ma&utm_content=2KJLrQm9NEwXvXWu28QMCd9jU6c7'),
      ('sạc dự phòng - baseus, 22.5W, 20000mAh', 'e-device', NULL, NULL),
      ('headphone', 'e-device', NULL, NULL),
      ('khóa dây có số (để khóa vali nếu đi tàu EU)', 'others', 'rockbros', 'https://shopee.vn/product/92745262/23280108920?d_id=7d992&uls_trackid=569uno0100s6&utm_content=2KJLrQm9NFEh3J9EhWnDSkSCvsEo'),
      ('vòi xịt cầm tay', 'hygiene stuffs', NULL, 'https://shopee.vn/product/820960773/28918199869?d_id=ef165&fbclid=IwY2xjawTe7YthZmRrCXNnTXFFYlB6LWV4dG4DYWVtAjExAHNydGMGYXBwX2lkDzQzNzYyNjMxNjk3Mzc4OAABHuEggzHvt-t2F02VYyu_BphjECxUn0QMxg8dCp8RvaWa11-kBLALMsr5n_hY_aem_L05keDd3NUHwZ5JXcvVpig&rModelId=252071634857&uls_trackid=56a8r3pm00t9&utm_content=25AhWgmMSZzoPDxa5WK3dqkq725d'),
      ('xịt mạt bụi', 'hygiene stuffs', NULL, 'https://shopee.vn/product/710340332/19965884184?d_id=7d992&uls_trackid=569unrpb02s6&utm_content=2KJLrQm9NFDinxrSeaxRt6fEL6zT'),
      ('paw paw lucas dưỡng môi', 'cosmetic, kinke', NULL, NULL),
      ('C sủi', 'medicine', NULL, NULL),
      ('Thước kẻ be bé', 'medicine', NULL, NULL),
      ('ô (dù)', 'Clothes', NULL, NULL),
      ('Bùa bình an dán vali', 'food&kitchen supp', NULL, NULL),
      ('bông tẩy trang', 'cosmetic, kinke', NULL, NULL),
      ('sữa rửa mặt roundlab', 'cosmetic, kinke', NULL, NULL),
      ('thuốc nhỏ mắt rothko', 'medicine', NULL, NULL),
      ('lọ cồn xịt (khử trùng)', 'hygiene stuffs', NULL, NULL),
      ('bàn là mini', 'e-device', NULL, NULL),
      ('Gia vị việt nam', 'food&kitchen supp', NULL, NULL),
      ('tương ớt chinsu size nhỏ +1 (nhỡ)', 'food&kitchen supp', NULL, NULL),
      ('Máy cắt hình con tem', 'gifts', NULL, 'https://shopee.vn/product/1145688/48608718340?d_id=7d992&uls_trackid=56a8r2iq00i7&utm_content=2KJLrQm9SFU8eDBJn7SxN285sDYT')
    ON CONFLICT (name) DO UPDATE SET
      category = EXCLUDED.category,
      brand = EXCLUDED.brand,
      referral_link = EXCLUDED.referral_link
  `);

  // wishlist_item_id (a single-item cache column) has had zero reads/writes
  // since claiming became multi-item — drop it so its FK stops blocking
  // deletes/edits of wishlist items a legacy RSVP row happened to reference.
  await pool.query(`ALTER TABLE rsvps DROP COLUMN IF EXISTS wishlist_item_id`);

  // Dropped from the wishlist — no longer offered.
  await pool.query(`DELETE FROM wishlist_items WHERE name = 'AirTag (x2)'`);

  // Superseded by the merged 'tương ớt chinsu size nhỏ +1 (nhỡ)' item —
  // only ever deletes it while unclaimed, so a real guest claim is never lost.
  await pool.query(`
    DELETE FROM wishlist_items
    WHERE name = 'Tương ớt Chinsu (size nhỡ)' AND claimed_by_rsvp_id IS NULL
  `);

  // 'Lọ cồn xịt (khử trùng)' was missing from the rename pass above, so the
  // lowercase upsert above created a second row instead of updating this one
  // in place — clean up the resulting stale, uncategorized duplicate. Only
  // ever deletes it if still unclaimed, so a real guest claim is never lost.
  await pool.query(`
    DELETE FROM wishlist_items
    WHERE name = 'Lọ cồn xịt (khử trùng)' AND claimed_by_rsvp_id IS NULL
  `);

  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS attending BOOLEAN NOT NULL DEFAULT true`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS note TEXT`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS photo_path TEXT`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS voice_path TEXT`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS gift_type TEXT`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS public_token TEXT`);
  await pool.query(`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS sheet_row INTEGER`);

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

  let arrival = null, transport = null, channels = [];
  const note = String(req.body?.note || '').trim().slice(0, MAX_MESSAGE_LEN);
  const photoPath = req.files?.photo?.[0]?.filename || null;
  const voicePath = req.files?.voice?.[0]?.filename || null;

  if (attending) {
    arrival = String(req.body?.arrival || '').trim().slice(0, MAX_FIELD_LEN);
    if (!arrival) return res.status(400).json({ error: 'Arrival time is required' });
    transport = String(req.body?.transport || '').trim().slice(0, MAX_FIELD_LEN);
    channels = [].concat(req.body?.channels || [])
      .map(c => String(c).trim().slice(0, 40)).filter(Boolean).slice(0, 10);
  }

  const giftChoice = String(req.body?.giftChoice || '').trim(); // 'contribute' | 'wishlist' | ''
  // One wishlist gift per guest — only the first valid selection is used
  // even if the client sends more.
  const wishlistItemIds = giftChoice === 'wishlist'
    ? [...new Set([].concat(req.body?.wishlistItemId || []).map(Number).filter(Number.isInteger))].slice(0, 1)
    : [];

  const newToken = crypto.randomUUID();

  let rsvpId, publicToken, isUpdate, sheetRowOnRecord, claimedNames = [], conflictNames = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO rsvps (fullname, email, attending, arrival, transport, channels, note, photo_path, voice_path, public_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (email) DO UPDATE SET
         fullname=EXCLUDED.fullname, attending=EXCLUDED.attending, arrival=EXCLUDED.arrival,
         transport=EXCLUDED.transport, channels=EXCLUDED.channels, note=EXCLUDED.note,
         photo_path=EXCLUDED.photo_path, voice_path=EXCLUDED.voice_path
       RETURNING id, public_token, sheet_row, (xmax <> 0) AS is_update`,
      [fullname, email, attending, arrival, transport, channels, note, photoPath, voicePath, newToken]
    );
    rsvpId = rows[0].id;
    publicToken = rows[0].public_token;
    isUpdate = rows[0].is_update;
    sheetRowOnRecord = rows[0].sheet_row;

    if (giftChoice === 'contribute') {
      await client.query('UPDATE rsvps SET gift_type=$1 WHERE id=$2', ['contribute', rsvpId]);
    } else if (giftChoice === 'wishlist' && wishlistItemIds.length) {
      for (const itemId of wishlistItemIds) {
        const claim = await client.query(
          `UPDATE wishlist_items SET claimed_by_rsvp_id=$1, claimed_at=now()
           WHERE id=$2 AND claimed_by_rsvp_id IS NULL RETURNING id, name`,
          [rsvpId, itemId]
        );
        if (claim.rowCount > 0) {
          claimedNames.push(claim.rows[0].name);
        } else {
          const { rows: nameRows } = await client.query('SELECT name FROM wishlist_items WHERE id=$1', [itemId]);
          conflictNames.push(nameRows[0]?.name || `#${itemId}`); // someone else claimed it in the same instant — RSVP still succeeds
        }
      }
      if (claimedNames.length) {
        await client.query('UPDATE rsvps SET gift_type=$1 WHERE id=$2', ['wishlist', rsvpId]);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    return res.status(500).json({ error: 'Failed to save RSVP' });
  } finally {
    client.release();
  }

  // Always report the guest's full current gift state (this submission's
  // picks plus anything claimed earlier) — a single item column can't
  // represent "holds several wishlist items", so this is computed fresh.
  const { summary: giftSummary } = await computeGiftSummary(rsvpId);

  (async () => {
    const sheetValues = [
      new Date().toISOString(),
      isUpdate ? 'RSVP Updated' : 'RSVP',
      fullname,
      email,
      attending ? 'Yes' : 'No',
      arrival || '',
      transport || '',
      note || '',
      photoPath ? 'Yes' : 'No',
      voicePath ? 'Yes' : 'No',
      giftSummary || (conflictNames.length ? 'Conflict — not claimed' : ''),
      channels.join(', '),
    ];
    // One row per guest: reuse their existing row if we have or can find one.
    const sheetRow = await resolveSheetRow(rsvpId, email, sheetRowOnRecord);
    if (sheetRow) {
      updateSheetRow(sheetRow, sheetValues);
    } else {
      const newSheetRow = await appendSheetRow(sheetValues);
      if (newSheetRow) {
        pool.query('UPDATE rsvps SET sheet_row=$1 WHERE id=$2', [newSheetRow, rsvpId])
          .catch(err => console.error('Failed to persist sheet_row', err.message));
      }
    }
  })().catch(err => console.error('Failed to sync Google Sheet row', err.message));

  if (transporter) {
    const attachments = [];
    if (photoPath) attachments.push({ filename: photoPath, path: path.join(UPLOAD_DIR, photoPath) });
    if (voicePath) attachments.push({ filename: voicePath, path: path.join(UPLOAD_DIR, voicePath) });

    const giftLineForGuest = claimedNames.length
      ? `You've claimed ${claimedNames.map(n => `"${n}"`).join(', ')} from the wishlist — thank you!`
      : conflictNames.length
      ? `The gift${conflictNames.length > 1 ? 's' : ''} you picked (${conflictNames.join(', ')}) ${conflictNames.length > 1 ? 'were' : 'was'} just claimed by someone else — use the link below to pick another.`
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

  res.status(201).json({ ok: true, id: rsvpId, token: publicToken, updated: isUpdate, giftNames: claimedNames, giftConflicts: conflictNames });
});

// Lets a returning guest (identified by their public_token, the same one
// used to manage their gift) fetch their current RSVP details to populate
// an edit form — never exposes anything by email/id lookup, token only.
app.get('/api/rsvp/me', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = String(req.query?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const { rows } = await pool.query(
      `SELECT fullname, email, attending, arrival, transport, channels FROM rsvps WHERE public_token=$1`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'RSVP not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load RSVP' });
  }
});

// Dedicated edit path for a returning guest changing their name, email,
// arrival time, transport, or invitation channels — deliberately separate
// from POST /api/rsvp (which is keyed by email via ON CONFLICT and also
// juggles file uploads + gift claiming) so an email change here can't
// orphan the guest's token, and editing these fields never touches their
// note/photo/voice/gift state.
app.post('/api/rsvp/update', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const fullname = String(req.body?.fullname || '').trim().slice(0, MAX_FIELD_LEN);
  const email = String(req.body?.email || '').trim().slice(0, MAX_FIELD_LEN);
  if (!token || !fullname || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query(
      'SELECT id, email, attending, sheet_row, note, photo_path, voice_path FROM rsvps WHERE public_token=$1',
      [token]
    );
    if (!existingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'RSVP not found. Please refresh and try again.' });
    }
    const existing = existingRows[0];
    const oldEmail = existing.email; // the sheet still has this until the row is overwritten below

    let arrival = null, transport = null, channels = [];
    if (existing.attending) {
      arrival = String(req.body?.arrival || '').trim().slice(0, MAX_FIELD_LEN);
      if (!arrival) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Arrival time is required' });
      }
      transport = String(req.body?.transport || '').trim().slice(0, MAX_FIELD_LEN);
      channels = [].concat(req.body?.channels || [])
        .map(c => String(c).trim().slice(0, 40)).filter(Boolean).slice(0, 10);
    }

    let updatedEmail;
    try {
      const { rows } = await client.query(
        `UPDATE rsvps SET fullname=$1, email=$2, arrival=$3, transport=$4, channels=$5
         WHERE id=$6 RETURNING email`,
        [fullname, email, arrival, transport, channels, existing.id]
      );
      updatedEmail = rows[0].email;
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'That email is already used by another RSVP.' });
      }
      throw err;
    }

    await client.query('COMMIT');

    (async () => {
      const { summary: giftSummary } = await computeGiftSummary(existing.id);
      const sheetValues = [
        new Date().toISOString(), 'RSVP Updated', fullname, updatedEmail,
        existing.attending ? 'Yes' : 'No', arrival || '', transport || '',
        existing.note || '', existing.photo_path ? 'Yes' : 'No', existing.voice_path ? 'Yes' : 'No',
        giftSummary, channels.join(', '),
      ];
      // Verify/find the row using the OLD email — the sheet cell still has
      // it at this point, since updateSheetRow below is what overwrites it
      // with updatedEmail. Checking against the new email would never
      // match, since nothing in the sheet has it yet.
      const sheetRow = await resolveSheetRow(existing.id, oldEmail, existing.sheet_row);
      if (sheetRow) {
        updateSheetRow(sheetRow, sheetValues);
      } else {
        const newRow = await appendSheetRow(sheetValues);
        if (newRow) {
          pool.query('UPDATE rsvps SET sheet_row=$1 WHERE id=$2', [newRow, existing.id])
            .catch(err => console.error('Failed to persist sheet_row', err.message));
        }
      }
    })().catch(err => console.error('Failed to sync Google Sheet row', err.message));

    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to update RSVP' });
  } finally {
    client.release();
  }
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
      `SELECT id, name, category, referral_link AS "referralLink",
              (claimed_by_rsvp_id IS NOT NULL) AS claimed,
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

    const { rows: rsvpRows } = await client.query('SELECT id, fullname, email, sheet_row FROM rsvps WHERE public_token=$1', [token]);
    if (!rsvpRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'RSVP not found' });
    }
    const rsvp = rsvpRows[0];

    // One wishlist gift per guest — must release their current one first.
    const { rows: heldRows } = await client.query(
      'SELECT id FROM wishlist_items WHERE claimed_by_rsvp_id=$1', [rsvp.id]
    );
    if (heldRows.length && heldRows[0].id !== itemId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You can only choose one gift from the wishlist — release your current choice first to pick a different one.' });
    }

    const claim = await client.query(
      `UPDATE wishlist_items SET claimed_by_rsvp_id=$1, claimed_at=now()
       WHERE id=$2 AND claimed_by_rsvp_id IS NULL RETURNING id, name`,
      [rsvp.id, itemId]
    );
    if (claim.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This gift has already been claimed.' });
    }

    await client.query('UPDATE rsvps SET gift_type=$1 WHERE id=$2', ['wishlist', rsvp.id]);
    await client.query('COMMIT');

    // Update this guest's existing sheet row rather than appending a new
    // line every time they change their gift choice.
    const { summary: giftSummary } = await computeGiftSummary(rsvp.id);
    const sheetRow = await resolveSheetRow(rsvp.id, rsvp.email, rsvp.sheet_row);
    if (sheetRow) {
      updateSheetGiftCell(sheetRow, giftSummary).catch(() => {});
    } else {
      appendSheetRow([
        new Date().toISOString(), 'Gift Claimed', rsvp.fullname, rsvp.email,
        '', '', '', '', '', '', giftSummary, '',
      ]);
    }

    if (transporter) {
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

    const { rows: rsvpRows } = await client.query('SELECT id, fullname, email, sheet_row FROM rsvps WHERE public_token=$1', [token]);
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

    // A guest can hold several items — only clear the 'wishlist' gift_type
    // flag once none remain (an independent 'contribute' pledge, if any, is
    // untouched either way).
    const { rows: remaining } = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM wishlist_items WHERE claimed_by_rsvp_id=$1', [rsvp.id]
    );
    if (remaining[0].cnt === 0) {
      await client.query(`UPDATE rsvps SET gift_type = CASE WHEN gift_type = 'wishlist' THEN NULL ELSE gift_type END WHERE id=$1`, [rsvp.id]);
    }
    await client.query('COMMIT');

    // Same one-row-per-guest rule as claim: clear the existing row's Gift
    // cell instead of appending (or deleting) a row — reflects the guest's
    // full remaining gift set, not just the item just released.
    const { summary: giftSummary } = await computeGiftSummary(rsvp.id);
    const sheetRow = await resolveSheetRow(rsvp.id, rsvp.email, rsvp.sheet_row);
    if (sheetRow) {
      updateSheetGiftCell(sheetRow, giftSummary).catch(() => {});
    } else {
      appendSheetRow([
        new Date().toISOString(), 'Gift Released', rsvp.fullname, rsvp.email,
        '', '', '', '', '', '', giftSummary, '',
      ]);
    }

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
