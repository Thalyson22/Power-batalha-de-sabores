import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PRE = new Set(['pina-colada', 'uva', 'manga', 'laranja-tangerina']);
// Morango, baunilha e cookies estão ocultos na página (hidden no index.html) e fora da disputa.
// Para voltarem, inclua-os aqui e remova o hidden; o banco já aceita os cinco sabores.
const WHEY = new Set(['chocolate', 'leitinho']);
const MAX_BODY_BYTES = 1024;

// Cada falha de configuração informa qual variável corrigir, nunca o valor dela.
function environment(env) {
  const value = name => String(env[name] ?? '').trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
  const rawUrl = value('SUPABASE_URL');
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl); }
  catch { throw new Error('SUPABASE_URL'); }
  // supabase.com é o painel, não a API do projeto (abcd1234.supabase.co).
  if (!rawUrl || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname) || /(^|\.)supabase\.com$/i.test(url.hostname)) throw new Error('SUPABASE_URL');
  // O painel mostra a chave mascarada (sb_secret_xxxxx••••); só o botão de copiar entrega a chave inteira.
  const key = value('SUPABASE_SECRET_KEY');
  if (!/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(key)) throw new Error('SUPABASE_SECRET_KEY');
  const secret = value('VOTE_COOKIE_SECRET');
  if (secret.length < 32 || secret.includes('SUBSTITUA')) throw new Error('VOTE_COOKIE_SECRET');
  const poll = value('POLL_ID') || 'power-2026-10-13';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(poll)) throw new Error('POLL_ID');
  return { base: url.origin, key, secret, poll };
}

// Na Vercel, request.url pode chegar como http:// atrás do proxy; o endereço público vem dos cabeçalhos x-forwarded-*.
function publicOrigin(request) {
  const url = new URL(request.url);
  const first = name => request.headers.get(name)?.split(',')[0].trim();
  const proto = first('x-forwarded-proto');
  return ((proto === 'https' || proto === 'http') ? proto : url.protocol.slice(0, -1)) + '://' + (first('x-forwarded-host') || first('host') || url.host);
}

function mac(id, secret) { return createHmac('sha256', secret).update('power-cookie:' + id).digest('base64url'); }
function identity(request, secret, secure) {
  const name = secure ? '__Host-power_vote' : 'power_vote_dev';
  const raw = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
  let id;
  if (raw && /^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/.test(raw)) {
    const [candidate, signature] = raw.split('.');
    const expected = mac(candidate, secret);
    if (timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) id = candidate;
  }
  const existing = Boolean(id);
  id ||= randomBytes(24).toString('base64url');
  return {
    existing,
    hash: createHmac('sha256', secret).update('power-voter:' + id).digest('hex'),
    cookie: name + '=' + id + '.' + mac(id, secret) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000' + (secure ? '; Secure' : '')
  };
}

function response(body, status = 200, cookie, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0',
    'Vercel-CDN-Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(JSON.stringify(body), { status, headers });
}

async function rpc(config, name, args, fetcher) {
  let result;
  try {
    result = await fetcher(config.base + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: { apikey: config.key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000)
    });
  } catch { throw new Error('DATABASE_UNREACHABLE'); }
  if (result.status === 401 || result.status === 403) throw new Error('DATABASE_KEY');
  if (result.status === 404) throw new Error('DATABASE_SETUP');
  if (!result.ok) {
    // PGRST002: a Data API está desativada ou sem schemas expostos no Supabase.
    const code = await result.json().then(body => body?.code, () => null);
    throw new Error(code === 'PGRST002' ? 'DATABASE_API' : 'DATABASE_ERROR');
  }
  let data;
  try { data = await result.json(); } catch { throw new Error('DATABASE_RESPONSE'); }
  if (data === null) throw new Error('CAMPAIGN_NOT_FOUND');
  if (!data || !Number.isSafeInteger(data.total) || data.total < 0 || !data.counts?.pre || !data.counts?.whey || !data.event) throw new Error('DATABASE_RESPONSE');
  return data;
}

const REASONS = new Set(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'VOTE_COOKIE_SECRET', 'POLL_ID', 'DATABASE_UNREACHABLE', 'DATABASE_KEY', 'DATABASE_SETUP', 'DATABASE_API', 'DATABASE_ERROR', 'DATABASE_RESPONSE', 'CAMPAIGN_NOT_FOUND']);
const reasonOf = error => REASONS.has(error?.message) ? error.message : 'UNKNOWN';

export async function handlePoll(request, { env = process.env, fetcher = fetch } = {}) {
  if (!['GET', 'POST'].includes(request.method)) return response({ error: 'METHOD_NOT_ALLOWED' }, 405, null, { Allow: 'GET, POST' });
  let config;
  try { config = environment(env); }
  catch (error) {
    const reason = reasonOf(error);
    console.error('[poll] configuração inválida:', reason);
    return response({ error: 'POLL_UNAVAILABLE', reason, message: 'A votação ainda não está disponível. Tente novamente em instantes.' }, 503);
  }

  if (request.headers.get('sec-fetch-site') === 'cross-site') return response({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
  const origin = publicOrigin(request);
  const voter = identity(request, config.secret, origin.startsWith('https:'));
  const args = { p_campaign: config.poll, p_voter_hash: voter.hash };
  let functionName = 'power_poll_snapshot';
  if (request.method === 'POST') {
    // Sec-Fetch-Site é definido pelo navegador e não pode ser forjado por scripts de outros sites.
    if (request.headers.get('sec-fetch-site') !== 'same-origin' && request.headers.get('origin') !== origin) return response({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
    if (!voter.existing) return response({ error: 'SESSION_REQUIRED', message: 'Recarregue a página para confirmar seu voto.' }, 409, voter.cookie);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return response({ error: 'JSON_REQUIRED' }, 415);
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return response({ error: 'BODY_TOO_LARGE' }, 413);
    let body;
    try {
      const text = await request.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return response({ error: 'BODY_TOO_LARGE' }, 413);
      body = JSON.parse(text);
    } catch { return response({ error: 'INVALID_JSON' }, 400); }
    if (!body || !PRE.has(body.pre) || !WHEY.has(body.whey) || Object.keys(body).some(key => !['pre', 'whey'].includes(key))) {
      return response({ error: 'INVALID_FLAVORS', message: 'Escolha um sabor válido de cada categoria.' }, 400);
    }
    args.p_pre = body.pre;
    args.p_whey = body.whey;
    functionName = 'power_cast_vote';
  }
  try {
    const snapshot = await rpc(config, functionName, args, fetcher);
    return response(snapshot, 200, voter.cookie);
  } catch (error) {
    // Só o código do motivo: sem tokens, cabeçalhos ou dados de visitantes nos logs ou na resposta pública.
    const reason = reasonOf(error);
    console.error('[poll] falha no banco:', reason);
    return response({ error: 'POLL_UNAVAILABLE', reason, message: 'Não foi possível consultar a votação. Tente novamente.' }, 503, voter.cookie);
  }
}
