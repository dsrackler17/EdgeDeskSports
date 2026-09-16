-- Consensus reference ages are medians and can contain half seconds.
-- Integer JSON inputs rejected whole signal and tick batches (22P02).
set lock_timeout = '5s';
alter table public.signals alter column ref_quote_age_s type numeric using ref_quote_age_s::numeric;
alter table public.signal_ticks alter column ref_quote_age_s type numeric using ref_quote_age_s::numeric;
notify pgrst, 'reload schema';