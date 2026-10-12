import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePoll } from '../lib/poll-server.js';

const POLL = 'power-2026-10-13';
const ENV = {
  SUPABASE_URL: 'https://exemplo.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_teste',
  VOTE_COOKIE_SECRET: 'x'.repeat(40),
  POLL_ID: POLL
};

// Banco simulado com as mesmas regras de database/setup.sql.
function fakeDatabase({ open = true } = {}) {
  const ballots = new Map();
  const calls = [];
  const snapshot = (campaign, hash) => {
    const counts = { pre: {}, whey: {} };
    for (const b of ballots.values()) {
      counts.pre[b.pre] = (counts.pre[b.pre] || 0) + 1;
      counts.whey[b.whey] = (counts.whey[b.whey] || 0) + 1;
    }
    const own = ballots.get(hash);
    return {
      event: { id: campaign, date: '2026-10-13', open, closesAt: null },
      total: ballots.size,
      counts,
      receipt: own ? { pre: own.pre, whey: own.whey, submittedAt: own.at } : null,
      updatedAt: new Date().toISOString()
    };
  };
  const fetcher = async (url, init) => {
    const args = JSON.parse(init.body);
    calls.push({ url, init, args });
    if (url.endsWith('/power_poll_snapshot')) return Response.json(snapshot(args.p_campaign, args.p_voter_hash));
    if (ballots.has(args.p_voter_hash)) return Response.json({ ...snapshot(args.p_campaign, args.p_voter_hash), accepted: false, alreadyVoted: true });
    if (!open) return Response.json({ ...snapshot(args.p_campaign, args.p_voter_hash), accepted: false, closed: true });
    ballots.set(args.p_voter_hash, { pre: args.p_pre, whey: args.p_whey, at: new Date().toISOString() });
    return Response.json({ ...snapshot(args.p_campaign, args.p_voter_hash), accepted: true, alreadyVoted: false });
  };
  return { fetcher, calls, ballots };
}

const ORIGIN = 'https://power.example';
function get(cookie, headers = {}) {
  return new Request(ORIGIN + '/api/poll', { headers: { ...(cookie && { cookie }), ...headers } });
}
function post(cookie, body, headers = {}) {
  return new Request(ORIGIN + '/api/poll', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie && { cookie }), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];

async function newBrowser(db) {
  const response = await handlePoll(get(), { env: ENV, fetcher: db.fetcher });
  assert.equal(response.status, 200);
  return cookieOf(response);
}

test('primeira visita recebe ranking e cookie assinado protegido', async () => {
  const db = fakeDatabase();
  const response = await handlePoll(get(), { env: ENV, fetcher: db.fetcher });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-power_vote=[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=31536000; Secure$/);
  const data = await response.json();
  assert.equal(data.total, 0);
  assert.equal(data.receipt, null);
});

test('voto confirmado soma nas duas categorias e reenvio não altera nem duplica', async () => {
  const db = fakeDatabase();
  const cookie = await newBrowser(db);
  const first = await handlePoll(post(cookie, { pre: 'uva', whey: 'leitinho' }), { env: ENV, fetcher: db.fetcher });
  assert.equal(first.status, 200);
  const a = await first.json();
  assert.equal(a.accepted, true);
  assert.equal(a.total, 1);
  assert.deepEqual(a.counts, { pre: { uva: 1 }, whey: { leitinho: 1 } });
  assert.deepEqual([a.receipt.pre, a.receipt.whey], ['uva', 'leitinho']);

  const again = await (await handlePoll(post(cookie, { pre: 'manga', whey: 'cookies' }), { env: ENV, fetcher: db.fetcher })).json();
  assert.equal(again.alreadyVoted, true);
  assert.equal(again.total, 1);
  assert.equal(again.receipt.pre, 'uva');

  const reload = await (await handlePoll(get(cookie), { env: ENV, fetcher: db.fetcher })).json();
  assert.equal(reload.receipt.whey, 'leitinho');
});

test('navegadores diferentes contam separadamente', async () => {
  const db = fakeDatabase();
  const one = await newBrowser(db), two = await newBrowser(db);
  assert.notEqual(one, two);
  await handlePoll(post(one, { pre: 'uva', whey: 'leitinho' }), { env: ENV, fetcher: db.fetcher });
  const data = await (await handlePoll(post(two, { pre: 'uva', whey: 'morango' }), { env: ENV, fetcher: db.fetcher })).json();
  assert.equal(data.total, 2);
  assert.deepEqual(data.counts, { pre: { uva: 2 }, whey: { leitinho: 1, morango: 1 } });
  assert.equal(data.receipt.whey, 'morango');
});

test('banco recebe apenas o hash do navegador, com a chave no cabeçalho apikey', async () => {
  const db = fakeDatabase();
  const cookie = await newBrowser(db);
  await handlePoll(post(cookie, { pre: 'manga', whey: 'chocolate' }), { env: ENV, fetcher: db.fetcher });
  const call = db.calls.at(-1);
  assert.equal(call.url, 'https://exemplo.supabase.co/rest/v1/rpc/power_cast_vote');
  assert.equal(call.init.headers.apikey, ENV.SUPABASE_SECRET_KEY);
  assert.equal(call.init.headers.Authorization, undefined);
  assert.match(call.args.p_voter_hash, /^[0-9a-f]{64}$/);
  assert.ok(!call.init.body.includes(cookie.split('=')[1].split('.')[0]));
  assert.deepEqual(call.args, { p_campaign: POLL, p_voter_hash: call.args.p_voter_hash, p_pre: 'manga', p_whey: 'chocolate' });
});

test('voto sem cookie válido pede recarga e não chega ao banco', async () => {
  const db = fakeDatabase();
  const missing = await handlePoll(post(null, { pre: 'uva', whey: 'leitinho' }), { env: ENV, fetcher: db.fetcher });
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error, 'SESSION_REQUIRED');
  assert.ok(cookieOf(missing));

  const cookie = await newBrowser(db);
  const forged = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
  const tampered = await handlePoll(post(forged, { pre: 'uva', whey: 'leitinho' }), { env: ENV, fetcher: db.fetcher });
  assert.equal(tampered.status, 409);
  assert.equal(db.ballots.size, 0);
});

test('origem, formato e sabores inválidos são recusados', async () => {
  const db = fakeDatabase();
  const cookie = await newBrowser(db);
  const status = async request => (await handlePoll(request, { env: ENV, fetcher: db.fetcher })).status;
  assert.equal(await status(post(cookie, { pre: 'uva', whey: 'leitinho' }, { origin: 'https://outro.example' })), 403);
  assert.equal(await status(get(cookie, { 'sec-fetch-site': 'cross-site' })), 403);
  assert.equal(await status(post(cookie, { pre: 'uva', whey: 'leitinho' }, { 'content-type': 'text/plain' })), 415);
  assert.equal(await status(post(cookie, '{"pre":')), 400);
  assert.equal(await status(post(cookie, { pre: 'uva' })), 400);
  assert.equal(await status(post(cookie, { pre: 'uva', whey: 'cafe' })), 400);
  assert.equal(await status(post(cookie, { pre: 'leitinho', whey: 'uva' })), 400);
  assert.equal(await status(post(cookie, { pre: 'uva', whey: 'leitinho', extra: 1 })), 400);
  assert.equal(await status(post(cookie, { pre: 'uva', whey: 'leitinho', pad: 'x'.repeat(2000) })), 413);
  const put = await handlePoll(new Request(ORIGIN + '/api/poll', { method: 'PUT' }), { env: ENV, fetcher: db.fetcher });
  assert.equal(put.status, 405);
  assert.equal(put.headers.get('allow'), 'GET, POST');
  assert.equal(db.ballots.size, 0);
});

test('votação encerrada mantém ranking e não registra voto', async () => {
  const db = fakeDatabase({ open: false });
  const cookie = await newBrowser(db);
  const data = await (await handlePoll(post(cookie, { pre: 'uva', whey: 'leitinho' }), { env: ENV, fetcher: db.fetcher })).json();
  assert.equal(data.closed, true);
  assert.equal(data.event.open, false);
  assert.equal(data.receipt, null);
  assert.equal(db.ballots.size, 0);
});

test('configuração incompleta informa qual variável corrigir, sem consultar o banco', async t => {
  t.mock.method(console, 'error', () => {});
  const bad = [
    [{}, 'SUPABASE_URL'],
    [{ ...ENV, SUPABASE_URL: 'http://exemplo.supabase.co' }, 'SUPABASE_URL'],
    [{ ...ENV, SUPABASE_URL: 'postgresql://postgres:senha@db.exemplo.supabase.co:5432/postgres' }, 'SUPABASE_URL'],
    [{ ...ENV, SUPABASE_URL: 'https://supabase.com/dashboard/project/abcd1234/settings/api' }, 'SUPABASE_URL'],
    [{ ...ENV, SUPABASE_SECRET_KEY: undefined }, 'SUPABASE_SECRET_KEY'],
    [{ ...ENV, SUPABASE_SECRET_KEY: 'eyJhbGciOiJIUzI1NiJ9.legado' }, 'SUPABASE_SECRET_KEY'],
    [{ ...ENV, SUPABASE_SECRET_KEY: 'sb_publishable_abc' }, 'SUPABASE_SECRET_KEY'],
    [{ ...ENV, VOTE_COOKIE_SECRET: 'curto' }, 'VOTE_COOKIE_SECRET'],
    [{ ...ENV, VOTE_COOKIE_SECRET: 'SUBSTITUA_POR_32_OU_MAIS_CARACTERES_ALEATORIOS' }, 'VOTE_COOKIE_SECRET'],
    [{ ...ENV, POLL_ID: 'id inválido' }, 'POLL_ID']
  ];
  for (const [env, reason] of bad) {
    let called = false;
    const response = await handlePoll(get(), { env, fetcher: async () => { called = true; } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'POLL_UNAVAILABLE', reason, message: 'A votação ainda não está disponível. Tente novamente em instantes.' });
    assert.equal(called, false);
  }
});

test('valores colados com espaços ou URL sem https:// continuam válidos', async () => {
  const db = fakeDatabase();
  const env = {
    SUPABASE_URL: '  exemplo.supabase.co/  ',
    SUPABASE_SECRET_KEY: ' sb_secret_teste\n',
    VOTE_COOKIE_SECRET: '\t' + 'x'.repeat(40) + ' ',
    POLL_ID: ' power-2026-10-13\n'
  };
  const response = await handlePoll(get(), { env, fetcher: db.fetcher });
  assert.equal(response.status, 200);
  const call = db.calls.at(-1);
  assert.equal(call.url, 'https://exemplo.supabase.co/rest/v1/rpc/power_poll_snapshot');
  assert.equal(call.init.headers.apikey, 'sb_secret_teste');
  assert.equal(call.args.p_campaign, POLL);
});

test('falha ou resposta inválida do banco vira 503 com o motivo e sem detalhes internos', async t => {
  const logs = t.mock.method(console, 'error', () => {});
  const failures = [
    [async () => { throw new Error('conexão recusada sb_secret_teste'); }, 'DATABASE_UNREACHABLE'],
    [async () => new Response('{"message":"Invalid API key sb_secret_teste"}', { status: 401 }), 'DATABASE_KEY'],
    [async () => new Response('{"code":"PGRST202"}', { status: 404 }), 'DATABASE_SETUP'],
    [async () => new Response('{"message":"sb_secret_teste"}', { status: 500 }), 'DATABASE_ERROR'],
    [async () => Response.json(null), 'CAMPAIGN_NOT_FOUND'],
    [async () => new Response('<html>', { status: 200 }), 'DATABASE_RESPONSE'],
    [async () => Response.json({ total: -1, counts: { pre: {}, whey: {} }, event: {} }), 'DATABASE_RESPONSE']
  ];
  for (const [fetcher, reason] of failures) {
    const response = await handlePoll(get(), { env: ENV, fetcher });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: 'POLL_UNAVAILABLE', reason, message: 'Não foi possível consultar a votação. Tente novamente.' });
    assert.ok(!text.includes('sb_secret'));
  }
  assert.equal(logs.mock.callCount(), failures.length);
  for (const call of logs.mock.calls) assert.ok(!call.arguments.join(' ').includes('sb_secret'));
});

test('cookie local sem HTTPS não usa prefixo __Host-', async () => {
  const db = fakeDatabase();
  const response = await handlePoll(new Request('http://localhost:3000/api/poll'), { env: ENV, fetcher: db.fetcher });
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^power_vote_dev=/);
  assert.ok(!cookie.includes('Secure'));
});
