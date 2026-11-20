-- 1. Профили учеников, часы, бейдж First Volunteer и одноразовый QR-купон
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  school_name text not null default 'BINOM им. Ә. Бөкейхана',
  grade text not null,
  telegram text not null,
  interests text[] not null default '{}',
  role text not null default 'student' check (role in ('student', 'volunteer', 'admin')),
  verified_hours integer not null default 0,
  is_first_volunteer boolean not null default false,
  qr_token uuid not null unique default gen_random_uuid(),
  qr_used boolean not null default false,
  qr_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- 2. Лента волонтёрства и школьных проектов
create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('volunteering', 'project')),
  title text not null,
  description text not null,
  school_name text not null,
  category text not null,
  hours integer not null default 2,
  spots_total integer not null default 10,
  author_name text not null,
  author_telegram text not null,
  is_approved boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3. Отклики учеников на задачи и проекты
create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'completed')),
  created_at timestamptz not null default now(),
  unique (opportunity_id, student_id)
);

-- 4. Трекинг сканирований NFC и QR-точек по школе
create table if not exists public.nfc_hits (
  id bigserial primary key,
  point_name text not null,
  created_at timestamptz not null default now()
);

-- 5. Стартовые задачи, чтобы сайт не был пустым в день запуска
insert into public.opportunities (type, title, description, school_name, category, hours, spots_total, author_name, author_telegram)
values
  ('volunteering', 'First Volunteer: запуск платформы в школе', 'Помощь со сканированием QR-купонов и регистрацией учеников на большой перемене. Выдаётся бейдж First Volunteer.', 'Все школы BINOM', 'События', 3, 8, 'Команда BINOM Impact', '@binom_impact'),
  ('volunteering', 'Старшак-ментор: разбор физики и математики', 'Провести 45-минутный разбор олимпиадных задач для 7–8 классов после уроков.', 'BINOM им. Ә. Бөкейхана', 'Менторство', 2, 5, 'Школьный STEM-клуб', '@binom_stem'),
  ('volunteering', 'Media Crew: съёмка школьного турнира', 'Фото, короткие Reels и монтаж итогового ролика со школьного мероприятия.', 'Все школы BINOM', 'Медиа', 3, 4, 'Школьный парламент', '@binom_media'),
  ('project', 'Команда на инженерный хакатон (Aerospace / IT)', 'Ищем 2 участников (Python и дизайн/CAD) для участия в ближайшем республиканском хакатоне.', 'Все школы BINOM', 'STEM', 4, 3, 'Организатор проекта', '@binom_aero');
