-- 2025-04 — Add broker_config JSONB to profiles for IBKR Flex
-- (and any future brokerage) read-only credentials.
--
-- RLS on profiles already restricts reads to ``auth.uid() = id``,
-- so the new column inherits that policy automatically — no extra
-- policy needed.
--
-- Idempotent: safe to re-run on a database that already has the
-- column.

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS broker_config JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.broker_config IS
    'Read-only brokerage credentials, RLS-scoped. Shape: {"ibkr": {"flex": {"token": "...", "query_id": "..."}}}';

-- Force PostgREST to drop its schema cache so the new column is
-- visible to the API immediately. Without this, the API auto-
-- refreshes within ~30 s, but the wait can confuse users who try
-- to save broker_config right after applying the migration.
NOTIFY pgrst, 'reload schema';
