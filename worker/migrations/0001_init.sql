-- RabbleBabble V2 schema.
--
-- Counters only. No audio, no transcripts, no instruction text, ever. The
-- backend is a pass-through proxy, and this schema is where that promise is
-- either kept or quietly broken.
--
-- Magic-link tokens and session tokens are stored as SHA-256 hashes rather
-- than raw values. They are bearer credentials: possession is authentication.
-- Storing verifiers means a leaked backup, a stray `d1 execute --remote`, or a
-- future read-only bug still cannot mint a valid cookie. A single SHA-256 is
-- correct here, not bcrypt or argon2 - these are 256-bit random tokens, so
-- there is no offline brute force to slow down, and a KDF on every request
-- would burn Worker CPU for nothing.

CREATE TABLE users (
  id                     TEXT    PRIMARY KEY,
  email                  TEXT    NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'suspended')),
  invite_code_hash       TEXT,
  audio_seconds_override INTEGER,
  created_at             INTEGER NOT NULL,
  last_seen_at           INTEGER
);
CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE TABLE auth_tokens (
  token_hash         TEXT    PRIMARY KEY,
  user_id            TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Binds the link to the device that asked for it, so a forwarded email
  -- cannot be redeemed by whoever it was forwarded to.
  request_nonce_hash TEXT,
  -- Peppered, so abuse forensics do not cost a log of who dictated from where.
  request_ip_hash    TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  consumed_at        INTEGER
);
CREATE INDEX idx_auth_tokens_expires ON auth_tokens (expires_at);
CREATE INDEX idx_auth_tokens_user ON auth_tokens (user_id);

CREATE TABLE sessions (
  session_hash    TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  user_agent_hash TEXT
);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE usage_daily (
  user_id                TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day                    TEXT    NOT NULL,
  audio_seconds          INTEGER NOT NULL DEFAULT 0,
  audio_seconds_reserved INTEGER NOT NULL DEFAULT 0,
  transcribe_calls       INTEGER NOT NULL DEFAULT 0,
  chat_calls             INTEGER NOT NULL DEFAULT 0,
  chat_tokens_in         INTEGER NOT NULL DEFAULT 0,
  chat_tokens_out        INTEGER NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX idx_usage_daily_day ON usage_daily (day);

-- The global budget. micros are USD micro-dollars.
CREATE TABLE spend_daily (
  day             TEXT    PRIMARY KEY,
  micros_spent    INTEGER NOT NULL DEFAULT 0,
  micros_reserved INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);

-- In-flight reservations. Written on reserve, deleted on settle or release.
-- Read only by the cron sweep, to give back budget leaked by a crashed isolate.
CREATE TABLE reservations (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL,
  day           TEXT    NOT NULL,
  audio_seconds INTEGER NOT NULL DEFAULT 0,
  micros        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_reservations_expires ON reservations (expires_at);

CREATE TABLE invite_codes (
  code_hash   TEXT    PRIMARY KEY,
  label       TEXT,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  disabled_at INTEGER
);

-- Fixed windows, e.g. 'ip:<hash>:2026-09-05T14' or 'email:<hash>:2026-09-05'.
CREATE TABLE auth_rate_limits (
  bucket       TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_auth_rate_limits_expires ON auth_rate_limits (expires_at);
