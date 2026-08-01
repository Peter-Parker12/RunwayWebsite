const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

const MAX_NAME_LEN = 60;
const MAX_MESSAGE_LEN = 500;

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.listen(port, () => {
  console.log(`Tide server listening on :${port}`);
});
