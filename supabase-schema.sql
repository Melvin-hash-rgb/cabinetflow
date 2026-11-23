-- ============================================================
--  CabinetFlow — Schéma de la base de données (Supabase / PostgreSQL)
--  ------------------------------------------------------------
--  CabinetFlow partage le MÊME projet Supabase que WorldLink :
--  toutes ses tables sont préfixées « cf_ » pour ne jamais se
--  mélanger avec celles de WorldLink.
--
--  Comment l'utiliser :
--  1. Ouvre le projet Supabase (le même que WorldLink).
--  2. Menu de gauche : « SQL Editor » → « New query ».
--  3. AVANT de lancer : cherche dans ce fichier la valeur
--       00000000-0000-0000-0000-000000000000
--     (elle n'apparaît qu'à UN seul endroit : la fonction
--     cf_is_owner, plus bas) et remplace-la par l'UUID du
--     compte Supabase Auth de Melvin, le propriétaire du
--     produit (Supabase → Authentication → Users → UUID).
--     C'est ce compte-là, et lui seul, qui pourra valider
--     les paiements des cabinets.
--  4. Colle TOUT ce fichier, puis clique « Run ».
--
--  Règles de sécurité (RLS) :
--  - Chaque cabinet est un espace fermé : un utilisateur ne
--    voit et ne modifie QUE les données des cabinets dont il
--    est membre (table cf_memberships).
--  - Le propriétaire du produit (Melvin) voit la liste des
--    cabinets et les paiements déclarés, pour les valider.
--  - Personne d'autre ne peut entrer dans le cabinet d'un autre.
-- ============================================================

-- ---------- Fonctions d'aide à la sécurité ----------
-- (security definer : elles lisent cf_memberships sans être
--  bloquées par ses propres règles, ce qui évite les boucles.)

create or replace function public.cf_is_owner()
returns boolean
language sql stable security definer set search_path = public
as $$
  -- ↓↓↓ REMPLACER PAR L'UUID DU COMPTE SUPABASE DE MELVIN ↓↓↓
  select auth.uid() = '00000000-0000-0000-0000-000000000000'::uuid;
$$;

create or replace function public.cf_is_member(p_cabinet_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.cf_memberships m
    where m.cabinet_id = p_cabinet_id
      and (
        m.user_id = auth.uid()
        or (m.user_id is null
            and lower(m.user_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
      )
  );
$$;

create or replace function public.cf_is_responsable(p_cabinet_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.cf_memberships m
    where m.cabinet_id = p_cabinet_id
      and m.user_id = auth.uid()
      and m.role = 'responsable'
  );
$$;

-- ---------- Table : les cabinets (un espace par cabinet) ----------
create table if not exists public.cf_cabinets (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  name          text not null,                    -- nom du cabinet
  city          text,                             -- ville (Douala, Yaoundé…)
  email         text,                             -- courriel de contact du cabinet
  phone         text,                             -- téléphone / WhatsApp du cabinet
  plan          text not null default 'essentiel', -- essentiel / pro / premium
  access_status text not null default 'essai',     -- essai / actif / grace / suspendu
  trial_end     date,                             -- fin de l'essai gratuit de 14 jours
  period_end    date,                             -- fin de la période payée en cours
  created_at    timestamptz not null default now()
);

-- ---------- Table : les membres d'un cabinet ----------
-- Un membre est ajouté par le responsable avec le courriel d'un
-- compte CabinetFlow existant : la ligne est créée avec user_id
-- vide, puis « réclamée » automatiquement à la connexion du membre.
create table if not exists public.cf_memberships (
  id         uuid primary key default gen_random_uuid(),
  cabinet_id uuid not null references public.cf_cabinets (id) on delete cascade,
  user_id    uuid references auth.users (id) on delete cascade,
  user_email text not null,                       -- courriel du membre
  role       text not null default 'employe',     -- responsable / employe
  created_at timestamptz not null default now(),
  unique (cabinet_id, user_email)
);

-- ---------- Table : les clients du cabinet ----------
create table if not exists public.cf_clients (
  id          uuid primary key default gen_random_uuid(),
  cabinet_id  uuid not null references public.cf_cabinets (id) on delete cascade,
  name        text not null,                      -- raison sociale / nom du client
  contact     text,                               -- personne de contact
  city        text,
  phone       text,
  email       text,
  niu         text,                               -- Numéro d'Identifiant Unique (impôts)
  tax_regime  text,                               -- régime fiscal (Réel, Simplifié…)
  tax_center  text,                               -- centre des impôts (DGE, CIME, CDI…)
  cnps_number text,                               -- numéro d'employeur CNPS
  syscohada   text,                               -- système SYSCOHADA (Normal, Minimal…)
  created_at  timestamptz not null default now()
);

-- ---------- Table : les dossiers ----------
create table if not exists public.cf_dossiers (
  id         uuid primary key default gen_random_uuid(),
  cabinet_id uuid not null references public.cf_cabinets (id) on delete cascade,
  client_id  uuid not null references public.cf_clients (id) on delete cascade,
  title      text not null,
  status     text not null default 'En cours',    -- En cours / Terminé
  due_date   date,
  created_at timestamptz not null default now()
);

-- ---------- Table : les documents ----------
-- Le fichier joint est gardé en data URL (comme WorldLink) :
-- photo ou petit fichier choisi depuis le téléphone.
create table if not exists public.cf_documents (
  id         uuid primary key default gen_random_uuid(),
  cabinet_id uuid not null references public.cf_cabinets (id) on delete cascade,
  dossier_id uuid references public.cf_dossiers (id) on delete set null,
  client_id  uuid references public.cf_clients (id) on delete set null,
  title      text not null,
  status     text not null default 'Manquant',    -- Reçu / Manquant / Demandé / Validé
  file_url   text,                                -- data URL du fichier joint
  file_name  text,
  created_at timestamptz not null default now()
);

-- ---------- Table : les échéances ----------
create table if not exists public.cf_deadlines (
  id         uuid primary key default gen_random_uuid(),
  cabinet_id uuid not null references public.cf_cabinets (id) on delete cascade,
  client_id  uuid references public.cf_clients (id) on delete cascade,
  title      text not null,
  due_date   date not null,
  kind       text not null default 'Manuel',      -- TVA / DIPE-CNPS / Patente / DSF / Manuel
  created_at timestamptz not null default now()
);

-- ---------- Table : les paiements d'abonnement ----------
-- Le montant est TOUJOURS celui du catalogue fixé par le
-- propriétaire (Essentiel 10 000 / Pro 25 000 / Premium
-- 45 000 FCFA par mois) : le cabinet choisit sa formule et
-- déclare son paiement ; le propriétaire valide.
create table if not exists public.cf_payments (
  id           uuid primary key default gen_random_uuid(),
  cabinet_id   uuid not null references public.cf_cabinets (id) on delete cascade,
  plan         text not null,                     -- essentiel / pro / premium
  amount       integer not null,                  -- montant du catalogue, en FCFA
  method       text not null,                     -- MTN Mobile Money / Orange Money / Virement / Carte
  reference    text,                              -- référence de la transaction déclarée
  status       text not null default 'declare',   -- declare / valide / rejete
  period_start date,
  period_end   date,
  created_at   timestamptz not null default now(),
  validated_at timestamptz
);

-- ---------- Index pour des recherches rapides ----------
create index if not exists idx_cf_memberships_user    on public.cf_memberships (user_id);
create index if not exists idx_cf_memberships_email   on public.cf_memberships (lower(user_email));
create index if not exists idx_cf_memberships_cabinet on public.cf_memberships (cabinet_id);
create index if not exists idx_cf_clients_cabinet     on public.cf_clients (cabinet_id);
create index if not exists idx_cf_dossiers_cabinet    on public.cf_dossiers (cabinet_id);
create index if not exists idx_cf_dossiers_client     on public.cf_dossiers (client_id);
create index if not exists idx_cf_documents_cabinet   on public.cf_documents (cabinet_id);
create index if not exists idx_cf_deadlines_cabinet   on public.cf_deadlines (cabinet_id);
create index if not exists idx_cf_deadlines_date      on public.cf_deadlines (due_date);
create index if not exists idx_cf_payments_cabinet    on public.cf_payments (cabinet_id);
create index if not exists idx_cf_payments_status     on public.cf_payments (status);

-- ============================================================
--  SÉCURITÉ (Row Level Security)
-- ============================================================

alter table public.cf_cabinets    enable row level security;
alter table public.cf_memberships enable row level security;
alter table public.cf_clients     enable row level security;
alter table public.cf_dossiers    enable row level security;
alter table public.cf_documents   enable row level security;
alter table public.cf_deadlines   enable row level security;
alter table public.cf_payments    enable row level security;

-- ----- cf_cabinets -----
create policy "Voir son cabinet"
  on public.cf_cabinets for select to authenticated
  using (public.cf_is_member(id) or owner_user_id = auth.uid() or public.cf_is_owner());
create policy "Créer son cabinet"
  on public.cf_cabinets for insert to authenticated
  with check (owner_user_id = auth.uid());
create policy "Modifier son cabinet"
  on public.cf_cabinets for update to authenticated
  using (owner_user_id = auth.uid() or public.cf_is_responsable(id) or public.cf_is_owner())
  with check (owner_user_id = auth.uid() or public.cf_is_responsable(id) or public.cf_is_owner());
create policy "Supprimer son cabinet"
  on public.cf_cabinets for delete to authenticated
  using (owner_user_id = auth.uid());

-- ----- cf_memberships -----
create policy "Voir les membres de son cabinet"
  on public.cf_memberships for select to authenticated
  using (
    user_id = auth.uid()
    or (user_id is null and lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
    or public.cf_is_member(cabinet_id)
    or public.cf_is_owner()
  );
create policy "Ajouter un membre"
  on public.cf_memberships for insert to authenticated
  with check (
    public.cf_is_responsable(cabinet_id)
    or (user_id = auth.uid() and role = 'responsable' and exists (
          select 1 from public.cf_cabinets c
          where c.id = cabinet_id and c.owner_user_id = auth.uid()))
  );
create policy "Réclamer ou modifier un membre"
  on public.cf_memberships for update to authenticated
  using (
    public.cf_is_responsable(cabinet_id)
    or (user_id is null and lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  )
  with check (
    public.cf_is_responsable(cabinet_id)
    or user_id = auth.uid()
  );
create policy "Retirer un membre"
  on public.cf_memberships for delete to authenticated
  using (public.cf_is_responsable(cabinet_id));

-- ----- cf_clients -----
create policy "Voir les clients de son cabinet"
  on public.cf_clients for select to authenticated
  using (public.cf_is_member(cabinet_id));
create policy "Ajouter un client"
  on public.cf_clients for insert to authenticated
  with check (public.cf_is_member(cabinet_id));
create policy "Modifier un client"
  on public.cf_clients for update to authenticated
  using (public.cf_is_member(cabinet_id)) with check (public.cf_is_member(cabinet_id));
create policy "Supprimer un client"
  on public.cf_clients for delete to authenticated
  using (public.cf_is_member(cabinet_id));

-- ----- cf_dossiers -----
create policy "Voir les dossiers de son cabinet"
  on public.cf_dossiers for select to authenticated
  using (public.cf_is_member(cabinet_id));
create policy "Ajouter un dossier"
  on public.cf_dossiers for insert to authenticated
  with check (public.cf_is_member(cabinet_id));
create policy "Modifier un dossier"
  on public.cf_dossiers for update to authenticated
  using (public.cf_is_member(cabinet_id)) with check (public.cf_is_member(cabinet_id));
create policy "Supprimer un dossier"
  on public.cf_dossiers for delete to authenticated
  using (public.cf_is_member(cabinet_id));

-- ----- cf_documents -----
create policy "Voir les documents de son cabinet"
  on public.cf_documents for select to authenticated
  using (public.cf_is_member(cabinet_id));
create policy "Ajouter un document"
  on public.cf_documents for insert to authenticated
  with check (public.cf_is_member(cabinet_id));
create policy "Modifier un document"
  on public.cf_documents for update to authenticated
  using (public.cf_is_member(cabinet_id)) with check (public.cf_is_member(cabinet_id));
create policy "Supprimer un document"
  on public.cf_documents for delete to authenticated
  using (public.cf_is_member(cabinet_id));

-- ----- cf_deadlines -----
create policy "Voir les échéances de son cabinet"
  on public.cf_deadlines for select to authenticated
  using (public.cf_is_member(cabinet_id));
create policy "Ajouter une échéance"
  on public.cf_deadlines for insert to authenticated
  with check (public.cf_is_member(cabinet_id));
create policy "Modifier une échéance"
  on public.cf_deadlines for update to authenticated
  using (public.cf_is_member(cabinet_id)) with check (public.cf_is_member(cabinet_id));
create policy "Supprimer une échéance"
  on public.cf_deadlines for delete to authenticated
  using (public.cf_is_member(cabinet_id));

-- ----- cf_payments -----
create policy "Voir les paiements de son cabinet"
  on public.cf_payments for select to authenticated
  using (public.cf_is_member(cabinet_id) or public.cf_is_owner());
create policy "Déclarer un paiement"
  on public.cf_payments for insert to authenticated
  with check (public.cf_is_member(cabinet_id));
create policy "Valider un paiement (propriétaire seulement)"
  on public.cf_payments for update to authenticated
  using (public.cf_is_owner()) with check (public.cf_is_owner());

-- ============================================================
--  Droits d'accès aux tables (GRANTS) — INDISPENSABLE.
--  Sans ces lignes, l'API répond « permission denied for table »
--  même quand les politiques RLS ci-dessus sont correctes :
--  les politiques sont la serrure, ces droits sont la porte.
--  (Leçon apprise lors du lancement de WorldLink.)
--  CabinetFlow est une application fermée : aucun accès anonyme.
-- ============================================================
grant select, insert, update, delete on public.cf_cabinets, public.cf_memberships,
  public.cf_clients, public.cf_dossiers, public.cf_documents,
  public.cf_deadlines, public.cf_payments to authenticated;
grant select, insert, update, delete on public.cf_cabinets, public.cf_memberships,
  public.cf_clients, public.cf_dossiers, public.cf_documents,
  public.cf_deadlines, public.cf_payments to service_role;

-- ============================================================
--  Fin du schéma CabinetFlow.
-- ============================================================
