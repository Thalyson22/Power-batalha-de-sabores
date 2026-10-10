import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PRE = new Set(['espinafreada', 'uva', 'manga', 'laranja-tangerina']);
const WHEY = new Set(['morango', 'baunilha', 'chocolate', 'cookies', 'leitinho']);
const MAX_BODY_BYTES = 1024;

function environment(env) {
  const url = new URL(env.SUPABASE_URL || 'https://invalid.invalid');
  if (!env.SUPABASE_URL || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('CONFIG');
  if (!env.SUPABASE_SECRET_KEY?.startsWith('sb_secret_')) throw new Error('CONFIG');
  if (!env.VOTE_COOKIE_SECRET || env.VOTE_COOKIE_SECRET.length < 32 || env.VOTE_COOKIE_SECRET.includes('SUBSTITUA')) throw new Error('CONFIG');
  const poll = env.POLL_ID || 'power-2026-10-13';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(poll)) throw new Error('CONFIG');
  return { base: url.origin, key: env.SUPABASE_SECRET_KEY, secret: env.VOTE_COOKIE_SECRET, poll };
}

function mac(id, secret) { return createHmac('sha256', secret).update('power-cookie:' + id).digest('base64url'); }
function identity(request, secret) {
  const secure = new URL(request.url).protocol === 'https:';
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
  const result = await fetcher(config.base + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000)
  });
  if (!result.ok) throw new Error('DATABASE_UNAVAILABLE');
  const data = await result.json();
  if (!data || !Number.isSafeInteger(data.total) || data.total < 0 || !data.counts?.pre || !data.counts?.whey || !data.event) throw new Error('INVALID_DATABASE_RESPONSE');
  return data;
}

export async function handlePoll(request, { env = process.env, fetcher = fetch } = {}) {
  if (!['GET', 'POST'].includes(request.method)) return response({ error: 'METHOD_NOT_ALLOWED' }, 405, null, { Allow: 'GET, POST' });
  let config;
  try { config = environment(env); }
  catch { return response({ error: 'POLL_UNAVAILABLE', message: 'A votação ainda não está disponível. Tente novamente em instantes.' }, 503); }

  if (request.headers.get('sec-fetch-site') === 'cross-site') return response({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
  const voter = identity(request, config.secret);
  const args = { p_campaign: config.poll, p_voter_hash: voter.hash };
  let functionName = 'power_poll_snapshot';
  if (request.method === 'POST') {
    if (request.headers.get('origin') !== new URL(request.url).origin) return response({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
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
  } catch {
    // Sem tokens, cabeçalhos ou dados de visitantes nos logs ou na resposta pública.
    return response({ error: 'POLL_UNAVAILABLE', message: 'Não foi possível consultar a votação. Tente novamente.' }, 503, voter.cookie);
  }
}
