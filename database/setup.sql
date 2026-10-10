-- Power Nutrifit: execute este arquivo completo no SQL Editor do Supabase.
-- Não apaga votos e não reabre campanhas existentes ao executar novamente.
begin;
create schema if not exists power_private;
revoke all on schema power_private from public, anon, authenticated, service_role;

create table if not exists power_private.campaigns (
  id text primary key,
  event_date date not null,
  is_open boolean not null default true,
  closes_at timestamptz
);
create table if not exists power_private.ballots (
  campaign_id text not null references power_private.campaigns(id),
  voter_hash text not null check (voter_hash ~ '^[0-9a-f]{64}$'),
  pre text not null check (pre in ('espinafreada', 'uva', 'manga', 'laranja-tangerina')),
  whey text not null check (whey in ('morango', 'baunilha', 'chocolate', 'cookies', 'leitinho')),
  submitted_at timestamptz not null default now(),
  primary key (campaign_id, voter_hash)
);
alter table power_private.campaigns enable row level security;
alter table power_private.ballots enable row level security;
revoke all on power_private.campaigns, power_private.ballots from public, anon, authenticated, service_role;

insert into power_private.campaigns(id, event_date)
values ('power-2026-10-13', '2026-10-13')
on conflict(id) do nothing;

-- Total e as duas categorias são lidos no mesmo snapshot do banco.
create or replace function public.power_poll_snapshot(p_campaign text, p_voter_hash text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with ballots as materialized (
    select b.pre, b.whey, b.submitted_at, b.voter_hash
    from power_private.ballots b where b.campaign_id = p_campaign
  )
  select jsonb_build_object(
    'event', jsonb_build_object('id', c.id, 'date', c.event_date,
      'open', c.is_open and (c.closes_at is null or c.closes_at > now()), 'closesAt', c.closes_at),
    'total', (select count(*) from ballots),
    'counts', jsonb_build_object(
      'pre', coalesce((select jsonb_object_agg(x.pre, x.n) from (select b.pre, count(*) n from ballots b group by b.pre) x), '{}'::jsonb),
      'whey', coalesce((select jsonb_object_agg(x.whey, x.n) from (select b.whey, count(*) n from ballots b group by b.whey) x), '{}'::jsonb)
    ),
    'receipt', (select jsonb_build_object('pre', b.pre, 'whey', b.whey, 'submittedAt', b.submitted_at)
      from ballots b where b.voter_hash = p_voter_hash),
    'updatedAt', now()
  ) from power_private.campaigns c where c.id = p_campaign;
$$;

-- As duas escolhas são gravadas juntas. Reenvio não duplica nem altera o voto.
create or replace function public.power_cast_vote(p_campaign text, p_voter_hash text, p_pre text, p_whey text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  campaign power_private.campaigns%rowtype;
  inserted integer;
begin
  if p_voter_hash is null or p_voter_hash !~ '^[0-9a-f]{64}$'
    or p_pre is null or p_pre not in ('espinafreada', 'uva', 'manga', 'laranja-tangerina')
    or p_whey is null or p_whey not in ('morango', 'baunilha', 'chocolate', 'cookies', 'leitinho') then
    raise exception 'INVALID_VOTE';
  end if;
  select c.* into campaign from power_private.campaigns c where c.id = p_campaign for share;
  if not found then raise exception 'CAMPAIGN_NOT_FOUND'; end if;

  if exists(select 1 from power_private.ballots b where b.campaign_id = p_campaign and b.voter_hash = p_voter_hash) then
    return public.power_poll_snapshot(p_campaign, p_voter_hash) || jsonb_build_object('accepted', false, 'alreadyVoted', true);
  end if;
  if not campaign.is_open or (campaign.closes_at is not null and campaign.closes_at <= now()) then
    return public.power_poll_snapshot(p_campaign, p_voter_hash) || jsonb_build_object('accepted', false, 'closed', true);
  end if;
  insert into power_private.ballots(campaign_id, voter_hash, pre, whey)
    values(p_campaign, p_voter_hash, p_pre, p_whey)
    on conflict(campaign_id, voter_hash) do nothing;
  get diagnostics inserted = row_count;
  return public.power_poll_snapshot(p_campaign, p_voter_hash)
    || jsonb_build_object('accepted', inserted = 1, 'alreadyVoted', inserted = 0);
end;
$$;

revoke all on function public.power_poll_snapshot(text,text) from public, anon, authenticated;
revoke all on function public.power_cast_vote(text,text,text,text) from public, anon, authenticated;
grant execute on function public.power_poll_snapshot(text,text) to service_role;
grant execute on function public.power_cast_vote(text,text,text,text) to service_role;
notify pgrst, 'reload schema';
commit;
