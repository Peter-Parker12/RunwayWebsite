CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO messages (name, message, created_at) VALUES
  ('M. Tran', 'So proud of this journey. Here''s to new shores.', now()),
  ('A. Nguyen', 'Eight years in the making — can''t wait to see where the tide takes you next.', now());
