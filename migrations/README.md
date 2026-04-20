# Database migrations

Each file in this folder is a self-contained, idempotent SQL migration
to apply to a Supabase database that was originally created from
`../supabase_migration.sql`. Run them in date order — every block is
guarded with `IF NOT EXISTS` / `DO $$` checks so re-running is safe.

## How to apply

1. Open Supabase Dashboard → SQL Editor.
2. Paste the contents of the migration file.
3. Run it.
4. Each migration ends with `NOTIFY pgrst, 'reload schema';`, which
   tells PostgREST (the auto-generated REST API) to drop its schema
   cache immediately. Without this you'll get
   `Could not find the 'X' column of 'Y' in the schema cache` errors
   for ~30 s while the API refreshes on its own.

If you're setting up a brand-new Supabase project, run the full
`../supabase_migration.sql` instead — it already includes every
column listed below.

## Migrations

| File | What it adds |
|---|---|
| `2025-04-broker-config.sql` | `profiles.broker_config` JSONB for IBKR Flex (PORT function) and future brokerage credentials. |
