-- Rode depois de setup.sql no SQL Editor. Nenhum dado de teste é mantido.
begin;
do $$
declare
  poll text := 'power-self-test-' || txid_current()::text;
  a text := repeat('a', 64);
  b text := repeat('b', 64);
  result jsonb;
begin
  insert into power_private.campaigns(id, event_date) values (poll, '2026-10-13');
  result := public.power_poll_snapshot(poll, a);
  assert (result->>'total')::int = 0, 'A campanha deve iniciar zerada';
  result := public.power_cast_vote(poll, a, 'uva', 'leitinho');
  assert (result->>'accepted')::boolean, 'Primeiro voto deve ser aceito';
  assert (result->>'total')::int = 1, 'Deve haver uma participação';
  assert (result #>> '{counts,pre,uva}')::int = 1, 'Contagem Fritz incorreta';
  assert (result #>> '{counts,whey,leitinho}')::int = 1, 'Contagem whey incorreta';
  result := public.power_cast_vote(poll, a, 'manga', 'cookies');
  assert (result->>'alreadyVoted')::boolean, 'Reenvio deve ser reconhecido';
  assert (result->>'total')::int = 1, 'Reenvio não pode somar';
  assert (result #>> '{receipt,pre}') = 'uva', 'Reenvio não pode trocar voto';
  result := public.power_cast_vote(poll, b, 'manga', 'cookies');
  assert (result->>'total')::int = 2, 'Outro navegador deve somar';
  assert (result #>> '{counts,pre,uva}')::int + (result #>> '{counts,pre,manga}')::int = 2;
  assert (result #>> '{counts,whey,leitinho}')::int + (result #>> '{counts,whey,cookies}')::int = 2;
  update power_private.campaigns set is_open = false where id = poll;
  result := public.power_cast_vote(poll, repeat('c',64), 'uva', 'cookies');
  assert (result->>'closed')::boolean, 'Campanha fechada deve bloquear novos votos';
  assert (result->>'total')::int = 2, 'Votação fechada não pode alterar total';
  assert not has_function_privilege('anon', 'public.power_cast_vote(text,text,text,text)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.power_cast_vote(text,text,text,text)', 'EXECUTE');
  assert has_function_privilege('service_role', 'public.power_cast_vote(text,text,text,text)', 'EXECUTE');
  assert not has_schema_privilege('anon', 'power_private', 'USAGE');
  raise notice 'OK: soma, idempotência, voto original, encerramento e privilégios.';
end;
$$;
rollback;
