-- Таблица отчётов об улове. Уже применена в проекте Supabase;
-- файл нужен, чтобы развернуть базу заново в другом проекте (SQL Editor → Run).
create table public.fishing_catches (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  caught_at timestamptz not null check (caught_at > now() - interval '30 days' and caught_at < now() + interval '1 day'),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  place text check (char_length(place) <= 120),
  fish text not null check (fish in ('pike','perch','zander','bream','roach','carp','crucian','burbot')),
  season text not null default 'open' check (season in ('open','ice')),
  rating smallint not null check (rating between 1 and 5),
  fish_count smallint check (fish_count between 0 and 500),
  weight_kg numeric(6,2) check (weight_kg between 0 and 200),
  comment text check (char_length(comment) <= 500),
  forecast_score smallint check (forecast_score between 0 and 100),
  factors jsonb check (pg_column_size(factors) < 2000),
  client_id uuid not null
);
create index fishing_catches_geo_idx on public.fishing_catches (lat, lon);
create index fishing_catches_client_idx on public.fishing_catches (client_id, created_at);

alter table public.fishing_catches enable row level security;
create policy "fishing catches are public" on public.fishing_catches
  for select to anon, authenticated using (true);
create policy "anyone can report a catch" on public.fishing_catches
  for insert to anon, authenticated with check (true);

-- client_id наружу не отдаём; изменять и удалять записи посетители не могут
revoke select on public.fishing_catches from anon, authenticated;
grant select (id, created_at, caught_at, lat, lon, place, fish, season, rating, fish_count, weight_kg, comment, forecast_score, factors)
  on public.fishing_catches to anon, authenticated;
grant insert (caught_at, lat, lon, place, fish, season, rating, fish_count, weight_kg, comment, forecast_score, factors, client_id)
  on public.fishing_catches to anon, authenticated;

-- защита от спама: не больше 10 отчётов в час с одного браузера и 300 в час всего
create or replace function public.fishing_catches_rate_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.fishing_catches where client_id = new.client_id and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Слишком много отчётов, попробуйте позже';
  end if;
  if (select count(*) from public.fishing_catches where created_at > now() - interval '1 hour') >= 300 then
    raise exception 'Слишком много отчётов, попробуйте позже';
  end if;
  return new;
end $$;
revoke execute on function public.fishing_catches_rate_limit() from public, anon, authenticated;
create trigger fishing_catches_rate_limit before insert on public.fishing_catches
  for each row execute function public.fishing_catches_rate_limit();
