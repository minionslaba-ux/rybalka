-- Дневник рыбалок. Уже применено в проекте Supabase; файл — чтобы развернуть заново (SQL Editor → Run).
-- Нужна таблица fishing_catches из fishing_catches.sql.
-- Таблицы закрыты от прямого доступа; всё — через функции SECURITY DEFINER.
-- Без входа дневник открывается секретным ключом устройства (в базе — только SHA-256 ключа),
-- после входа по почте — по auth.uid(); при привязке к аккаунту ключ устройства перестаёт действовать.

create table public.fishing_diaries (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.fishing_trips (
  id bigint generated always as identity primary key,
  diary_id uuid not null references public.fishing_diaries(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trip_at timestamptz not null check (trip_at > '2000-01-01' and trip_at < now() + interval '2 days'),
  hours numeric(4,1) check (hours between 0 and 72),
  lat double precision check (lat between -90 and 90),
  lon double precision check (lon between -180 and 180),
  place text check (char_length(place) <= 120),
  fish text check (fish in ('pike','perch','zander','bream','roach','carp','crucian','burbot')),
  method text check (method in ('spinning','float','feeder','bottom','fly','jig','tipup','trolling','other')),
  bait text check (char_length(bait) <= 80),
  depth_m numeric(5,1) check (depth_m between 0 and 300),
  rating smallint not null check (rating between 1 and 5),
  fish_count smallint check (fish_count between 0 and 1000),
  weight_kg numeric(6,2) check (weight_kg between 0 and 500),
  biggest_kg numeric(5,2) check (biggest_kg between 0 and 100),
  notes text check (char_length(notes) <= 2000),
  nickname text check (char_length(nickname) <= 40),
  season text check (season in ('open','ice')),
  forecast_score smallint check (forecast_score between 0 and 100),
  weather jsonb check (pg_column_size(weather) < 4000),
  is_public boolean not null default false,
  catch_id bigint references public.fishing_catches(id) on delete set null
);
create index fishing_trips_diary_idx on public.fishing_trips (diary_id, trip_at desc);

alter table public.fishing_diaries enable row level security;
alter table public.fishing_trips enable row level security;
revoke all on public.fishing_diaries, public.fishing_trips from anon, authenticated;

-- Найти дневник: по ключу устройства или по вошедшему пользователю (внутренняя функция)
create or replace function public.fishing_diary_id(p_key text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  if p_key is not null and length(p_key) >= 20 then
    select id into v from fishing_diaries where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex');
  end if;
  if v is null and auth.uid() is not null then
    select id into v from fishing_diaries where user_id = auth.uid();
  end if;
  if v is null then raise exception 'Дневник не найден' using errcode = 'P0002'; end if;
  return v;
end $$;
revoke execute on function public.fishing_diary_id(text) from public, anon, authenticated;

create or replace function public.fishing_diary_create() returns text
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if auth.uid() is not null and exists (select 1 from fishing_diaries where user_id = auth.uid()) then
    raise exception 'У этого аккаунта уже есть дневник';
  end if;
  if (select count(*) from fishing_diaries where created_at > now() - interval '1 hour') >= 300 then
    raise exception 'Слишком много новых дневников, попробуйте позже';
  end if;
  k := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  insert into fishing_diaries (key_hash, user_id) values (encode(extensions.digest(k, 'sha256'), 'hex'), auth.uid());
  return k;
end $$;

create or replace function public.fishing_diary_trips(p_key text) returns setof public.fishing_trips
language sql stable security definer set search_path = public as $$
  select * from fishing_trips where diary_id = public.fishing_diary_id(p_key) order by trip_at desc limit 2000;
$$;

-- Сохранить запись. «Поделиться» — копия в fishing_catches с местом, округлённым до ~1 км (только за последние 30 дней).
create or replace function public.fishing_diary_save(p_key text, p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  d uuid := public.fishing_diary_id(p_key);
  t fishing_trips;
  v_id bigint := nullif(p->>'id', '')::bigint;
  can_share boolean;
begin
  if v_id is null then
    if (select count(*) from fishing_trips where diary_id = d and created_at > now() - interval '1 hour') >= 60 then
      raise exception 'Слишком много записей за час';
    end if;
    insert into fishing_trips (diary_id, trip_at, rating)
      values (d, (p->>'trip_at')::timestamptz, (p->>'rating')::smallint) returning id into v_id;
  elsif not exists (select 1 from fishing_trips where id = v_id and diary_id = d) then
    raise exception 'Запись не найдена';
  end if;

  update fishing_trips set
    updated_at = now(),
    trip_at = (p->>'trip_at')::timestamptz,
    hours = nullif(p->>'hours', '')::numeric,
    lat = nullif(p->>'lat', '')::float8, lon = nullif(p->>'lon', '')::float8,
    place = nullif(p->>'place', ''), fish = nullif(p->>'fish', ''), method = nullif(p->>'method', ''),
    bait = nullif(p->>'bait', ''), depth_m = nullif(p->>'depth_m', '')::numeric,
    rating = (p->>'rating')::smallint,
    fish_count = nullif(p->>'fish_count', '')::smallint, weight_kg = nullif(p->>'weight_kg', '')::numeric,
    biggest_kg = nullif(p->>'biggest_kg', '')::numeric,
    notes = nullif(p->>'notes', ''), nickname = nullif(p->>'nickname', ''),
    season = nullif(p->>'season', ''), forecast_score = nullif(p->>'forecast_score', '')::smallint,
    weather = case when jsonb_typeof(p->'weather') = 'object' then p->'weather' else null end,
    is_public = coalesce((p->>'is_public')::boolean, false)
  where id = v_id returning * into t;

  can_share := t.is_public and t.lat is not null and t.fish is not null and t.trip_at > now() - interval '29 days';
  if can_share and t.catch_id is null then
    insert into fishing_catches (caught_at, lat, lon, place, fish, season, rating, fish_count, weight_kg, comment,
                                 forecast_score, factors, client_id, method, bait, depth_m, nickname)
    values (t.trip_at, round(t.lat::numeric, 2), round(t.lon::numeric, 2), t.place, t.fish, coalesce(t.season, 'open'), t.rating,
            least(t.fish_count, 500), least(t.weight_kg, 200), left(t.notes, 500), t.forecast_score, null, d, t.method, t.bait, t.depth_m, t.nickname)
    returning id into t.catch_id;
    update fishing_trips set catch_id = t.catch_id where id = v_id;
  elsif can_share then
    update fishing_catches set caught_at = t.trip_at, lat = round(t.lat::numeric, 2), lon = round(t.lon::numeric, 2), place = t.place,
      fish = t.fish, season = coalesce(t.season, 'open'), rating = t.rating, fish_count = least(t.fish_count, 500),
      weight_kg = least(t.weight_kg, 200), comment = left(t.notes, 500), forecast_score = t.forecast_score,
      method = t.method, bait = t.bait, depth_m = t.depth_m, nickname = t.nickname
    where id = t.catch_id;
  elsif t.catch_id is not null then
    delete from fishing_catches where id = t.catch_id;
    update fishing_trips set catch_id = null where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.fishing_diary_delete(p_key text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare d uuid := public.fishing_diary_id(p_key); c bigint;
begin
  delete from fishing_trips where id = p_id and diary_id = d returning catch_id into c;
  if c is not null then delete from fishing_catches where id = c; end if;
end $$;

-- Привязать дневник устройства к аккаунту (или влить его записи в дневник аккаунта)
create or replace function public.fishing_diary_link(p_key text) returns text
language plpgsql security definer set search_path = public as $$
declare dev uuid; acc uuid;
begin
  if auth.uid() is null then raise exception 'Нужно войти в аккаунт'; end if;
  select id into acc from fishing_diaries where user_id = auth.uid();
  if p_key is not null then
    select id into dev from fishing_diaries where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex');
  end if;
  if dev is null then return case when acc is null then 'none' else 'account' end; end if;
  if acc is null then
    update fishing_diaries set user_id = auth.uid(),
      key_hash = encode(extensions.digest(extensions.gen_random_bytes(32), 'sha256'), 'hex')
    where id = dev;
    return 'linked';
  end if;
  if acc = dev then
    update fishing_diaries set key_hash = encode(extensions.digest(extensions.gen_random_bytes(32), 'sha256'), 'hex') where id = dev;
    return 'account';
  end if;
  update fishing_trips set diary_id = acc where diary_id = dev;
  update fishing_catches set client_id = acc where client_id = dev;
  delete from fishing_diaries where id = dev;
  return 'merged';
end $$;

revoke execute on function public.fishing_diary_create(), public.fishing_diary_trips(text), public.fishing_diary_save(text, jsonb),
  public.fishing_diary_delete(text, bigint), public.fishing_diary_link(text) from public;
grant execute on function public.fishing_diary_create(), public.fishing_diary_trips(text), public.fishing_diary_save(text, jsonb),
  public.fishing_diary_delete(text, bigint), public.fishing_diary_link(text) to anon, authenticated;
