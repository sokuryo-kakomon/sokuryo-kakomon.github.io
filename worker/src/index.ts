// 過去問ドリル（測量士・宅建・行政書士）の「AI に質問」中継サーバー（Cloudflare Workers）。
// 同じコードを wrangler の env ごとに別の Worker として出す（KV・Stripe の商品・許可するサイトは別々）。
// どのサイト用かは SITE_KEY（sokuryo / takken / gyosei）で決まる。
//
//   POST /ask       {qid, messages, code?, turnstile?} → Claude の答えを text/plain で少しずつ返す
//   POST /checkout  → Stripe の支払い画面（月額980円）の URL
//   GET  /code      ?session_id= → 支払いが済んでいれば利用コードを返す（何度呼んでも同じコード）
//   POST /status    {code} → コードの有効・今日と今月の残り
//   POST /portal    {code} → Stripe の契約管理画面（解約・カード変更）の URL
//   POST /stripe-webhook → 解約・支払い失敗でコードを止め、再開で戻す
//
// API キー類はブラウザに出さず、Worker の secret にだけ置く。ログインは作らず「利用コード」で見分ける。
//
// 使いすぎの止め（KV の日付・月ごとの数え）:
//   無料: IP ごと 1日 FREE_PER_IP 回、無料全体で 1日 FREE_TOTAL 回、Turnstile（人間の確認）
//   有料: コードごと 1日 PAID_PER_DAY 回・1か月 PAID_PER_MONTH 回（配られても全員でこの数を分け合うだけ）
//   最後の砦は Anthropic Console の月額上限。
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';

export interface Env {
  ANTHROPIC_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID: string;
  SITE_KEY?: string;           // sokuryo（既定）/ takken / gyosei
  TURNSTILE_SECRET?: string;   // 無ければ人間の確認を飛ばす（手元の試験用）
  LIMITS: KVNamespace;
  SITE_URL: string;
  ALLOWED_ORIGINS: string;
  AI_MODEL: string;
  AI_MODEL_FREE: string;
  AI_EFFORT: string;
  FREE_PER_IP: string;
  FREE_TOTAL: string;
  PAID_PER_DAY: string;
  PAID_PER_MONTH: string;
}

interface Question {
  id: string; title: string; yearLabel: string; num: number; category: string; answer: number;
  statementText: string;
  items: { key: string; text: string }[];
  choices: { key: string; text: string }[];
  tablesHtml: string[];
  explanationText: string;
  ok?: number[];                                  // 正解と扱う番号すべて（複数正解の問）
  kind?: 'choice' | 'tashi' | 'kijutsu';          // 行政書士: 5肢択一・多肢選択・記述
  blanks?: Record<string, number>;                // 多肢選択の正解（空欄→語句の番号）
  words?: { key: string; text: string }[];        // 多肢選択の語群
  modelAnswer?: string;                           // 記述の解答例（このサイト作成）
}

interface CodeRec { sub: string; customer: string; active: boolean; created: number }

// 測量士は r07-q1・h30-q1、測量士補は h-r07-q1、宅建の令和2・3年は r02-10-q1・r02-12-q1
const QID = /^(h-)?[rh]\d{2}(-1[02])?-q\d{1,2}$/;
const CODE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;
const MAX_TURNS = 12;
const MAX_CHARS = 800;
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);

type Site = { exam: string; authority: string; knowledge: string; extra: string[] };
const SITES: Record<string, Site> = {
  sokuryo: {
    exam: '測量士試験・測量士補試験（択一式）', authority: '国土地理院', knowledge: '一般的な測量の知識',
    extra: [
      '解説に「規則の改正あり」とある問題は、今の規則と試験当時の規則の違いに触れる。',
      '計算は途中式を省かない。試験では関数表と貸与の電卓（√とメモリーが使える一般電卓）だけを使う前提で説明する。',
    ],
  },
  takken: {
    exam: '宅地建物取引士試験（宅建試験）', authority: '一般財団法人 不動産適正取引推進機構', knowledge: '宅建試験で問われる法令（民法・宅建業法・法令上の制限・税など）の一般的な知識',
    extra: ['試験の後に法改正があった論点は、試験当時の法令で答え、今の扱いが違えば一言添える。'],
  },
  gyosei: {
    exam: '行政書士試験', authority: '一般財団法人 行政書士試験研究センター', knowledge: '憲法・行政法・民法・商法などの一般的な法律知識と判例',
    extra: [
      '試験の後に法改正があった論点は、試験当時の法令で答え、今の扱いが違えば一言添える。',
      '判例は、解説に書かれているもの以外は裁判所名と年月日を作らない。確かでなければ「判例の立場では」と言う。',
      '記述式の問題では、解答例は唯一の正解ではないこと、採点で見られる語句（キーワード）を意識して説明する。',
    ],
  },
};
const siteOf = (env: Env): Site => SITES[env.SITE_KEY || 'sokuryo'] ?? SITES.sokuryo;

function systemRules(env: Env): string {
  const t = siteOf(env);
  return [
    `あなたは${t.exam}の受験生を助ける先生です。`,
    '下に示す1問について、受験生の質問に日本語で答えてください。',
    '',
    '答え方:',
    '- 結論を先に、短く。必要なら手順を番号つきで。見出しや表は使わず、ふつうの文章と箇条書きだけで書く。',
    `- 正解は「${t.authority}が発表した正解」として扱い、覆さない。`,
    `- 根拠は、下の「このサイトの解説」と${t.knowledge}に基づく。条文の番号は、解説に書かれているものだけを使い、自分で番号を作らない。`,
    ...t.extra.map((x) => '- ' + x),
    '- 確かでないことは「確かではない」と言う。',
    `- この問題や${t.exam}と関係のない依頼には、短く断ってこの問題の話に戻す。`,
  ].join('\n');
}

function questionBlock(q: Question, env: Env): string {
  const lines = [`【${q.title}】`, '', q.statementText];
  if (q.items.length) lines.push('', ...q.items.map((i) => `${i.key}. ${i.text}`));
  if (q.choices.length) lines.push('', ...q.choices.map((c) => `${c.key}. ${c.text}`));
  // 表はセルを「|」で区切った行にして渡す
  for (const t of q.tablesHtml ?? []) {
    const rows = t.split(/<\/tr>/i).map((r) => r.split(/<\/t[dh]>/i).map((c) => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ')).filter(Boolean);
    lines.push('', '（表）', ...rows);
  }
  const auth = siteOf(env).authority;
  if (q.kind === 'tashi' && q.blanks) {
    const w = new Map((q.words ?? []).map((x) => [x.key, x.text]));
    if (q.words?.length) lines.push('', '（語群）', ...q.words.map((x) => `${x.key}. ${x.text}`));
    lines.push('', `${auth}が発表した正解: ` + Object.entries(q.blanks).map(([k, v]) => `${k}=${v}（${w.get(String(v)) ?? ''}）`).join('、'));
  } else if (q.kind === 'kijutsu') {
    lines.push('', `解答例（このサイトが作成。${auth}は記述式の正解を公表していない）: ${q.modelAnswer ?? '（なし）'}`);
  } else {
    const ok = q.ok?.length ? q.ok.join('・') : String(q.answer);
    lines.push('', `${auth}が発表した正解: ${ok}`);
  }
  lines.push('', '【このサイトの解説】', q.explanationText);
  return lines.join('\n');
}

function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Remaining, X-Plan',
    'Vary': 'Origin',
  };
}

const text = (status: number, body: string, headers: Record<string, string>) =>
  new Response(body, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

// 日本時間の日付・月（回数は日本の0時・1日に戻す）
const jst = () => new Date(Date.now() + 9 * 3600_000).toISOString();
const today = () => jst().slice(0, 10);
const thisMonth = () => jst().slice(0, 7);

async function count(kv: KVNamespace, key: string) { return Number((await kv.get(key)) || 0); }
async function bump(kv: KVNamespace, key: string, ttlDays: number) {
  const n = (await count(kv, key)) + 1;
  await kv.put(key, String(n), { expirationTtl: ttlDays * 86400 });
  return n;
}

function validMessages(m: unknown): m is Anthropic.MessageParam[] {
  if (!Array.isArray(m) || m.length === 0 || m.length > MAX_TURNS || m.length % 2 === 0) return false;
  return m.every((x, i) =>
    x && typeof x === 'object' &&
    x.role === (i % 2 === 0 ? 'user' : 'assistant') &&
    typeof x.content === 'string' && x.content.length > 0 &&
    x.content.length <= (x.role === 'user' ? MAX_CHARS : 8000));
}

const stripeOf = (env: Env) => new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

function newCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 読み間違えやすい I O 0 1 を除く
  const b = crypto.getRandomValues(new Uint8Array(16));
  const s = [...b].map((x) => abc[x % abc.length]).join('');
  return s.match(/.{4}/g)!.join('-');
}

async function getCode(env: Env, code: unknown): Promise<CodeRec | null> {
  if (typeof code !== 'string' || !CODE.test(code)) return null;
  const v = await env.LIMITS.get(`code:${code}`);
  return v ? (JSON.parse(v) as CodeRec) : null;
}

// 同じ Stripe アカウントに3サイトの商品がある。支払いの印（metadata.site）がこのサイトの物かを見る。
// 印の無い支払いは、印を付け始める前の測量士のものだけ。
const siteKey = (env: Env) => env.SITE_KEY || 'sokuryo';
const isMine = (env: Env, meta: Record<string, string> | null | undefined) =>
  meta?.site ? meta.site === siteKey(env) : siteKey(env) === 'sokuryo';

// 支払い1件につきコードは1つ。画面（/code）と webhook のどちらが先に来ても同じコードになる
async function ensureCode(env: Env, subId: string, customer: string): Promise<string> {
  const have = await env.LIMITS.get(`sub:${subId}`);
  if (have) return have;
  const code = newCode();
  const rec: CodeRec = { sub: subId, customer, active: true, created: Date.now() };
  await env.LIMITS.put(`code:${code}`, JSON.stringify(rec));
  await env.LIMITS.put(`sub:${subId}`, code);
  return code;
}

async function setActive(env: Env, subId: string, active: boolean) {
  const code = await env.LIMITS.get(`sub:${subId}`);
  if (!code) return;
  const rec = await getCode(env, code);
  if (!rec || rec.active === active) return;
  await env.LIMITS.put(`code:${code}`, JSON.stringify({ ...rec, active }));
}

async function turnstileOk(env: Env, token: unknown, ip: string) {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || !token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET); form.append('response', token); form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  return ((await r.json()) as { success: boolean }).success === true;
}

async function ask(req: Request, env: Env, h: Record<string, string>): Promise<Response> {
  let body: { qid?: unknown; messages?: unknown; code?: unknown; turnstile?: unknown };
  try { body = await req.json(); } catch { return text(400, '送信内容を読めませんでした。', h); }
  const { qid, messages, code } = body;
  if (typeof qid !== 'string' || !QID.test(qid) || !validMessages(messages)) {
    return text(400, '質問の形が正しくありません（1回の質問は800字まで、やりとりは6往復まで）。', h);
  }

  const day = today(), month = thisMonth();
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  let dayKey: string, monthKey: string | null = null, plan: 'paid' | 'free', limitDay: number;

  if (code) {
    const rec = await getCode(env, code);
    if (!rec) return text(403, '利用コードが見つかりません。入力を確かめてください。', { ...h, 'X-Plan': 'none' });
    if (!rec.active) return text(403, 'この利用コードは停止中です（解約済み、またはお支払いが確認できていません）。', { ...h, 'X-Plan': 'stopped' });
    plan = 'paid'; limitDay = Number(env.PAID_PER_DAY);
    dayKey = `pd:${code}:${day}`; monthKey = `pm:${code}:${month}`;
    if (await count(env.LIMITS, dayKey) >= limitDay) return text(429, `今日の質問回数（${limitDay}回）を使い切りました。明日の0時にまた使えます。`, { ...h, 'X-Remaining': '0', 'X-Plan': plan });
    if (await count(env.LIMITS, monthKey) >= Number(env.PAID_PER_MONTH)) return text(429, `今月の質問回数（${env.PAID_PER_MONTH}回）を使い切りました。来月1日にまた使えます。`, { ...h, 'X-Remaining': '0', 'X-Plan': plan });
  } else {
    plan = 'free'; limitDay = Number(env.FREE_PER_IP);
    dayKey = `ip:${day}:${ip}`;
    if (await count(env.LIMITS, dayKey) >= limitDay) return text(429, `無料の質問（1日${limitDay}回）を使い切りました。`, { ...h, 'X-Remaining': '0', 'X-Plan': plan });
    if (await count(env.LIMITS, `free:${day}`) >= Number(env.FREE_TOTAL)) return text(429, '今日は無料の質問が混み合い、受付を締め切りました。', { ...h, 'X-Remaining': '0', 'X-Plan': plan });
    if (!(await turnstileOk(env, body.turnstile, ip))) return text(403, '確認に失敗しました。ページを開き直してお試しください。', { ...h, 'X-Plan': plan });
  }

  const qRes = await fetch(`${env.SITE_URL}/data/q/${qid}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!qRes.ok) return text(404, 'この問題のデータが見つかりませんでした。', h);
  const q = (await qRes.json()) as Question;

  // 数えてから問い合わせる（失敗しても1回と数える＝甘くしない）
  const n = await bump(env.LIMITS, dayKey, 2);
  if (monthKey) await bump(env.LIMITS, monthKey, 40);
  else await bump(env.LIMITS, `free:${day}`, 2);
  const remaining = String(Math.max(0, limitDay - n));

  // 無料は Sonnet、有料（利用コードあり）は Opus
  const model = plan === 'paid' ? env.AI_MODEL : env.AI_MODEL_FREE;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const params = {
    model,
    max_tokens: 2500,
    output_config: { effort: env.AI_EFFORT as 'low' | 'medium' | 'high' },
    // 問題と解説（毎回同じ）を先頭に置いてキャッシュに乗せる。続く往復は messages 側
    system: [
      { type: 'text' as const, text: systemRules(env) },
      { type: 'text' as const, text: questionBlock(q, env), cache_control: { type: 'ephemeral' as const } },
    ],
    messages,
  };
  const stream = FALLBACK_MODELS.has(model)
    ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : client.beta.messages.stream(params);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  (async () => {
    try {
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') await w.write(enc.encode(ev.delta.text));
      }
      const fin = await stream.finalMessage();
      if (fin.stop_reason === 'refusal') await w.write(enc.encode('\n\n（この質問にはお答えできませんでした。問題の内容について聞き直してください。）'));
      else if (fin.stop_reason === 'max_tokens') await w.write(enc.encode('\n\n（長くなったのでここで切れました。続きは「続けて」と聞いてください。）'));
    } catch (err) {
      console.error(err instanceof Anthropic.APIError ? `API ${err.status}: ${err.message}` : err);
      await w.write(enc.encode('\n\n（AI との通信に失敗しました。少し時間をおいて試してください。）'));
    } finally {
      await w.close();
    }
  })();
  return new Response(readable, {
    headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Remaining': remaining, 'X-Plan': plan },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Stripe からの知らせ（ブラウザ経由ではないので CORS の外）
    if (url.pathname === '/stripe-webhook' && req.method === 'POST') {
      const stripe = stripeOf(env);
      let event: Stripe.Event;
      try {
        event = await stripe.webhooks.constructEventAsync(await req.text(), req.headers.get('Stripe-Signature') || '',
          env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider());
      } catch { return new Response('bad signature', { status: 400 }); }
      if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        if (s.mode === 'subscription' && isMine(env, s.metadata) && typeof s.subscription === 'string' && typeof s.customer === 'string') await ensureCode(env, s.subscription, s.customer);
      } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        // active と trialing だけ使える。past_due（支払い失敗の猶予中）・canceled などは止める
        await setActive(env, sub.id, event.type === 'customer.subscription.updated' && (sub.status === 'active' || sub.status === 'trialing'));
      }
      return new Response('ok');
    }

    const h = cors(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: h['Access-Control-Allow-Origin'] ? 204 : 403, headers: h });
    if (!h['Access-Control-Allow-Origin']) return text(403, 'このサイトからのみ使えます。', h);

    if (url.pathname === '/ask' && req.method === 'POST') return ask(req, env, h);
    try {
      return await billing(req, url, env, h);
    } catch (err) {
      console.error(err instanceof Stripe.errors.StripeError ? `Stripe ${err.type}: ${err.message}` : err);
      return json(502, { error: '決済の処理に失敗しました。少し時間をおいてお試しください。' }, h);
    }
  },
};

// 支払い・コードまわり（Stripe を呼ぶもの）
async function billing(req: Request, url: URL, env: Env, h: Record<string, string>): Promise<Response> {
  // 戻り先は、許可した送り元（CORS で確かめ済み）のサイト。手元の試験でも本番でも同じ形で戻れる
  const base = h['Access-Control-Allow-Origin'] || env.SITE_URL;
  {

    if (url.pathname === '/checkout' && req.method === 'POST') {
      const s = await stripeOf(env).checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
        metadata: { site: siteKey(env) },
        subscription_data: { metadata: { site: siteKey(env) } },
        success_url: `${base}/ai/thanks/?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/ai/`,
        locale: 'ja',
      });
      return json(200, { url: s.url }, h);
    }

    if (url.pathname === '/code' && req.method === 'GET') {
      const id = url.searchParams.get('session_id') || '';
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json(400, { error: '支払いの番号が正しくありません。' }, h);
      const s = await stripeOf(env).checkout.sessions.retrieve(id);
      if (!isMine(env, s.metadata)) return json(404, { error: 'このサイトのお支払いではありません。' }, h);
      if (s.status !== 'complete' || typeof s.subscription !== 'string' || typeof s.customer !== 'string') {
        return json(409, { error: 'お支払いの完了がまだ確認できません。少し待ってから再読み込みしてください。' }, h);
      }
      return json(200, { code: await ensureCode(env, s.subscription, s.customer) }, h);
    }

    if (url.pathname === '/status' && req.method === 'POST') {
      const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
      const rec = await getCode(env, code);
      if (!rec) return json(404, { error: '利用コードが見つかりません。' }, h);
      const usedDay = await count(env.LIMITS, `pd:${code}:${today()}`);
      const usedMonth = await count(env.LIMITS, `pm:${code}:${thisMonth()}`);
      return json(200, {
        active: rec.active,
        todayLeft: Math.max(0, Number(env.PAID_PER_DAY) - usedDay),
        monthLeft: Math.max(0, Number(env.PAID_PER_MONTH) - usedMonth),
      }, h);
    }

    if (url.pathname === '/portal' && req.method === 'POST') {
      const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
      const rec = await getCode(env, code);
      if (!rec) return json(404, { error: '利用コードが見つかりません。' }, h);
      const p = await stripeOf(env).billingPortal.sessions.create({ customer: rec.customer, return_url: `${base}/ai/` });
      return json(200, { url: p.url }, h);
    }

    return text(404, 'not found', h);
  }
}
