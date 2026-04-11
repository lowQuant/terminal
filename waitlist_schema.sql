CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE public.waitlist (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  first_name text,
  last_name text,
  email text UNIQUE NOT NULL,
  features_wanted text NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert (so public users can submit the application)
CREATE POLICY "Allow public insert on waitlist" ON public.waitlist
  FOR INSERT WITH CHECK (true);

-- Block public from reading the waitlist table
CREATE POLICY "Deny public select on waitlist" ON public.waitlist
  FOR SELECT USING (false);
