-- ═══════════════════════════════════════════════════════════════
-- TERMINAL — Supabase Schema Migration
-- ═══════════════════════════════════════════════════════════════
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
-- Supabase manages auth.users automatically — these tables
-- extend it with app-specific data.
-- ═══════════════════════════════════════════════════════════════


-- ───────────────────────────────────────
-- 1. PROFILES
-- Extends auth.users with app-specific user data.
-- Auto-created via trigger on signup (see bottom).
-- ───────────────────────────────────────
CREATE TABLE public.profiles (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    first_name      TEXT,
    last_name       TEXT,
    display_name    TEXT,
    avatar_url      TEXT,
    subscription_tier TEXT NOT NULL DEFAULT 'free',   -- 'free', 'pro', 'premium', etc.
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,    -- manual kill switch
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    llm_keys        JSONB DEFAULT '{}'
);

COMMENT ON TABLE  public.profiles IS 'Public user profiles — one row per auth.users entry';
COMMENT ON COLUMN public.profiles.subscription_tier IS 'Gate features by tier: free, pro, premium';
COMMENT ON COLUMN public.profiles.is_active IS 'Set to FALSE to disable a user without deleting them';


-- ───────────────────────────────────────
-- 2. WATCHLISTS
-- A user can have multiple named watchlists.
-- ───────────────────────────────────────
CREATE TABLE public.watchlists (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT 'Default',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_watchlists_user ON public.watchlists(user_id);


-- ───────────────────────────────────────
-- 3. WATCHLIST ITEMS
-- Individual tickers inside a watchlist.
-- Stores both TradingView symbol AND yfinance ticker
-- because some exchanges (e.g. TSE for Japanese stocks)
-- don't support TradingView embeds and fall back to
-- Lightweight Charts + yfinance OHLCV data.
-- ───────────────────────────────────────
CREATE TABLE public.watchlist_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    watchlist_id    UUID NOT NULL REFERENCES public.watchlists(id) ON DELETE CASCADE,
    tv_symbol       TEXT,                   -- e.g. 'NASDAQ:AAPL' (NULL if TV unsupported)
    yf_ticker       TEXT NOT NULL,          -- e.g. 'AAPL' or '7203.T' (always present)
    display_name    TEXT,                   -- e.g. 'Apple Inc.' or 'Toyota Motor'
    exchange_label  TEXT,                   -- e.g. 'NASDAQ', 'TSE'
    tv_supported    BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE → use Lightweight Charts fallback
    sort_order      INTEGER NOT NULL DEFAULT 0,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(watchlist_id, yf_ticker)         -- no duplicate tickers per watchlist
);

CREATE INDEX idx_watchlist_items_watchlist ON public.watchlist_items(watchlist_id);

COMMENT ON COLUMN public.watchlist_items.tv_symbol IS 'TradingView EXCHANGE:TICKER — NULL when TV embed is not available';
COMMENT ON COLUMN public.watchlist_items.yf_ticker IS 'yfinance ticker — always populated, used for API calls and Lightweight Charts fallback';
COMMENT ON COLUMN public.watchlist_items.tv_supported IS 'FALSE for exchanges like TSE where TradingView embeds fail → triggers Lightweight Charts rendering';


-- ───────────────────────────────────────
-- 4. USER SESSIONS (login tracking)
-- Tracks sign-in / sign-out events for
-- security auditing and usage analytics.
-- ───────────────────────────────────────
CREATE TABLE public.user_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    logged_in_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    logged_out_at   TIMESTAMPTZ,
    ip_address      INET,
    user_agent      TEXT,
    country         TEXT                    -- optional, from IP geo lookup
);

CREATE INDEX idx_user_sessions_user   ON public.user_sessions(user_id);
CREATE INDEX idx_user_sessions_login  ON public.user_sessions(logged_in_at DESC);


-- ───────────────────────────────────────
-- 5. ACTIVITY LOG (usage / behaviour tracking)
-- Tracks in-app actions: searches, tab views,
-- chart interactions, etc. JSONB metadata field
-- keeps this flexible without schema changes.
-- ───────────────────────────────────────
CREATE TABLE public.activity_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    action      TEXT NOT NULL,              -- e.g. 'search', 'view_chart', 'view_financials', 'add_to_watchlist'
    symbol      TEXT,                       -- ticker involved (if any)
    metadata    JSONB DEFAULT '{}',         -- flexible: { "tab": "overview", "period": "1y", "query": "toyota" }
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_user      ON public.activity_log(user_id);
CREATE INDEX idx_activity_action    ON public.activity_log(action);
CREATE INDEX idx_activity_created   ON public.activity_log(created_at DESC);
CREATE INDEX idx_activity_symbol    ON public.activity_log(symbol) WHERE symbol IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY (RLS)
-- Critical for a public-facing app. Each user can only
-- read/write their own data, even if someone bypasses the UI.
-- ═══════════════════════════════════════════════════════════════

-- Enable RLS on all tables
ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlist_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log    ENABLE ROW LEVEL SECURITY;

-- ── Profiles ──
CREATE POLICY "Users can view their own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- ── Watchlists ──
CREATE POLICY "Users can view their own watchlists"
    ON public.watchlists FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own watchlists"
    ON public.watchlists FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own watchlists"
    ON public.watchlists FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own watchlists"
    ON public.watchlists FOR DELETE
    USING (auth.uid() = user_id);

-- ── Watchlist Items ──
CREATE POLICY "Users can view their own watchlist items"
    ON public.watchlist_items FOR SELECT
    USING (
        watchlist_id IN (
            SELECT id FROM public.watchlists WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can add to their own watchlists"
    ON public.watchlist_items FOR INSERT
    WITH CHECK (
        watchlist_id IN (
            SELECT id FROM public.watchlists WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update their own watchlist items"
    ON public.watchlist_items FOR UPDATE
    USING (
        watchlist_id IN (
            SELECT id FROM public.watchlists WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can remove from their own watchlists"
    ON public.watchlist_items FOR DELETE
    USING (
        watchlist_id IN (
            SELECT id FROM public.watchlists WHERE user_id = auth.uid()
        )
    );

-- ── User Sessions ──
CREATE POLICY "Users can view their own sessions"
    ON public.user_sessions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own sessions"
    ON public.user_sessions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own sessions"
    ON public.user_sessions FOR UPDATE
    USING (auth.uid() = user_id);

-- ── Activity Log ──
CREATE POLICY "Users can view their own activity"
    ON public.activity_log FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can log their own activity"
    ON public.activity_log FOR INSERT
    WITH CHECK (auth.uid() = user_id);


-- ═══════════════════════════════════════════════════════════════
-- AUTO-CREATE PROFILE ON SIGNUP
-- Fires after a new row appears in auth.users.
-- Extracts email and optional name from metadata.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    w_name TEXT;
    auto_activate BOOLEAN := FALSE;
BEGIN
    -- Check if the new user's email corresponds to an approved waitlist candidate
    SELECT name INTO w_name FROM public.waitlist WHERE email = NEW.email LIMIT 1;

    -- If they are on the waitlist, auto-activate their profile and remove them from the waitlist
    IF w_name IS NOT NULL THEN
        auto_activate := TRUE;
        DELETE FROM public.waitlist WHERE email = NEW.email;
    END IF;

    -- Note: If you want ALL invited users to be active regardless of waitlist, change auto_activate to TRUE unconditionally.

    INSERT INTO public.profiles (id, email, first_name, last_name, display_name, is_active)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data ->> 'first_name', split_part(w_name, ' ', 1), ''),
        COALESCE(NEW.raw_user_meta_data ->> 'last_name', NULLIF(substring(w_name from position(' ' in w_name) + 1), w_name), ''),
        COALESCE(
            NEW.raw_user_meta_data ->> 'display_name',
            w_name,
            NULLIF(TRIM(
                COALESCE(NEW.raw_user_meta_data ->> 'first_name', '') || ' ' ||
                COALESCE(NEW.raw_user_meta_data ->> 'last_name', '')
            ), ''),
            split_part(NEW.email, '@', 1)   -- fallback: use email prefix
        ),
        auto_activate -- Will be TRUE if they were found on the waitlist
    );

    -- Also create a default watchlist for the new user
    INSERT INTO public.watchlists (user_id, name)
    VALUES (NEW.id, 'Default');

    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();


-- ═══════════════════════════════════════════════════════════════
-- AUTO-UPDATE updated_at ON PROFILE CHANGES
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at();


-- ═══════════════════════════════════════════════════════════════
-- OPTIONAL: USEFUL VIEWS FOR ADMIN / ANALYTICS
-- ═══════════════════════════════════════════════════════════════

-- Daily active users
CREATE OR REPLACE VIEW public.v_daily_active_users AS
SELECT
    DATE(created_at) AS day,
    COUNT(DISTINCT user_id) AS active_users
FROM public.activity_log
GROUP BY DATE(created_at)
ORDER BY day DESC;

-- Most searched tickers
CREATE OR REPLACE VIEW public.v_popular_symbols AS
SELECT
    symbol,
    COUNT(*) AS search_count,
    COUNT(DISTINCT user_id) AS unique_users
FROM public.activity_log
WHERE action = 'search' AND symbol IS NOT NULL
GROUP BY symbol
ORDER BY search_count DESC;

-- User engagement summary
CREATE OR REPLACE VIEW public.v_user_engagement AS
SELECT
    p.id AS user_id,
    p.email,
    p.display_name,
    p.subscription_tier,
    p.created_at AS registered_at,
    COUNT(DISTINCT a.id) AS total_actions,
    MAX(a.created_at) AS last_active,
    COUNT(DISTINCT DATE(a.created_at)) AS active_days
FROM public.profiles p
LEFT JOIN public.activity_log a ON a.user_id = p.id
GROUP BY p.id, p.email, p.display_name, p.subscription_tier, p.created_at;


-- ═══════════════════════════════════════════════════════════════
-- WAITLIST
-- Stores applications for beta testing
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE public.waitlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  comments TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Row Level Security
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anonymous inserts" ON public.waitlist 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Allow read access for authenticated users only" ON public.waitlist
FOR SELECT 
USING (auth.role() = 'authenticated');
