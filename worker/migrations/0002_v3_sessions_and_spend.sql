-- V3. Three changes, all small.
--
-- 1. user_agent_hash was written on every sign-in and read by nothing. It is
--    pure privacy cost: a UA string has little enough entropy that an
--    unpeppered SHA-256 of one is effectively plaintext, and every other
--    fingerprint in this schema (IPs) is peppered.
-- 2. Per-user daily spend. Seconds and call counts existed; money did not, so
--    one user's caps could not be reconciled against the global budget at all.
-- 3. Personal vocabulary: the Whisper `prompt` bias, and the only piece of
--    user data worth storing on the server.

ALTER TABLE sessions DROP COLUMN user_agent_hash;

ALTER TABLE usage_daily ADD COLUMN micros_spent    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN micros_reserved INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN vocabulary TEXT NOT NULL DEFAULT '';
