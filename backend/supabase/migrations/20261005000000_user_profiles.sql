create table if not exists public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  identifier text not null,
  role text not null check (role in ('student', 'lecturer', 'admin')),
  name text not null,
  dept text,
  level text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists user_profiles_identifier_lower_uq
  on public.user_profiles (lower(identifier));

alter table public.user_profiles enable row level security;
revoke all on table public.user_profiles from anon, authenticated;
grant select, insert, update, delete on table public.user_profiles to service_role;
