// 測量士 過去問ドリル の「AI に質問」中継サーバー（Cloudflare Workers）。
//
// ブラウザ → POST /ask {qid, messages} → この Worker が問題データを本番サイトから取り、
// Claude に問い合わせて、答えの文字を少しずつそのまま返す（text/plain のストリーム）。
// API キーはブラウザに出さず、Worker の secret（ANTHROPIC_API_KEY）にだけ置く。
//
// 使いすぎの止め（どちらも KV の日付ごとの数え）:
//   - 1つの IP あたり 1日 DAILY_PER_IP 回
//   - 全体で 1日 DAILY_TOTAL 回（お金の上限の最後の砦。Anthropic Console の月額上限と二重にかける）
import Anthropic from '@anthropic-ai/sdk';

export interface Env {
  ANTHROPIC_API_KEY: string;
  LIMITS: KVNamespace;
  SITE_URL: string;          // 問題データの取得元（本番サイト）
  ALLOWED_ORIGINS: string;   // カンマ区切り
  AI_MODEL: string;
  AI_EFFORT: string;         // low | medium | high
  DAILY_PER_IP: string;
  DAILY_TOTAL: string;
}

interface Question {
  id: string; yearLabel: string; num: number; category: string; answer: number;
  statementText: string;
  items: { key: string; text: string }[];
  choices: { key: string; text: string }[];
  tablesHtml: string[];
  explanationText: string;
}

const QID = /^r\d{2}-q\d{1,2}$/;
const MAX_TURNS = 12;        // user と assistant を合わせた往復の上限（6往復）
const MAX_CHARS = 800;       // 1回の質問の長さ
// サーバー側フォールバック（拒否時に別モデルで続ける）を受け付けるモデル
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);

const SYSTEM_RULES = `あなたは測量士試験（午前・択一式）の受験生を助ける先生です。
下に示す1問について、受験生の質問に日本語で答えてください。

答え方:
- 結論を先に、短く。必要なら手順を番号つきで。見出しや表は使わず、ふつうの文章と箇条書きだけで書く。
- 正解は「国土地理院が発表した正解」として扱い、覆さない。
- 根拠は、下の「このサイトの解説」と一般的な測量の知識に基づく。条文の番号は、解説に書かれているものだけを使い、自分で番号を作らない。
- 解説に「規則の改正あり」とある問題は、今の規則と試験当時の規則の違いに触れる。
- 計算は途中式を省かない。試験では関数表と貸与の電卓（√とメモリーが使える一般電卓）だけを使う前提で説明する。
- 確かでないことは「確かではない」と言う。
- この問題や測量士試験と関係のない依頼には、短く断ってこの問題の話に戻す。`;

function questionBlock(q: Question): string {
  const lines = [`【${q.yearLabel} 午前 第${q.num}問（${q.category}）】`, '', q.statementText];
  if (q.items.length) lines.push('', ...q.items.map((i) => `${i.key}. ${i.text}`));
  if (q.choices.length) lines.push('', ...q.choices.map((c) => `${c.key}. ${c.text}`));
  // 表はセルを「|」で区切った行にして渡す
  for (const t of q.tablesHtml ?? []) {
    const rows = t.split(/<\/tr>/i).map((r) => r.split(/<\/t[dh]>/i).map((c) => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ')).filter(Boolean);
    lines.push('', '（表）', ...rows);
  }
  lines.push('', `国土地理院が発表した正解: ${q.answer}`, '', '【このサイトの解説】', q.explanationText);
  return lines.join('\n');
}

function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Remaining',
    'Vary': 'Origin',
  };
}

function reply(status: number, body: string, headers: Record<string, string>) {
  return new Response(body, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
}

// 日本時間の日付（回数は日本の0時に戻す）
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

async function bump(kv: KVNamespace, key: string): Promise<number> {
  const n = Number((await kv.get(key)) || 0) + 1;
  await kv.put(key, String(n), { expirationTtl: 2 * 86400 });
  return n;
}

function validMessages(m: unknown): m is Anthropic.MessageParam[] {
  if (!Array.isArray(m) || m.length === 0 || m.length > MAX_TURNS || m.length % 2 === 0) return false;
  return m.every((x, i) =>
    x && typeof x === 'object' &&
    x.role === (i % 2 === 0 ? 'user' : 'assistant') &&
    typeof x.content === 'string' && x.content.length > 0 &&
    // 過去の AI の答えは長くてよいが、受験生の質問は短く
    x.content.length <= (x.role === 'user' ? MAX_CHARS : 8000));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const h = cors(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: h['Access-Control-Allow-Origin'] ? 204 : 403, headers: h });
    const url = new URL(req.url);
    if (url.pathname !== '/ask' || req.method !== 'POST') return reply(404, 'not found', h);
    if (!h['Access-Control-Allow-Origin']) return reply(403, 'このサイトからのみ使えます。', h);

    let body: { qid?: unknown; messages?: unknown };
    try { body = await req.json(); } catch { return reply(400, '送信内容を読めませんでした。', h); }
    const { qid, messages } = body;
    if (typeof qid !== 'string' || !QID.test(qid) || !validMessages(messages)) {
      return reply(400, '質問の形が正しくありません（1回の質問は800字まで、やりとりは6往復まで）。', h);
    }

    // 回数の止め。先に全体、次に IP。数えてから問い合わせる（失敗しても1回と数える＝甘くしない）
    const day = today();
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const perIp = Number(env.DAILY_PER_IP), total = Number(env.DAILY_TOTAL);
    const usedIp = Number((await env.LIMITS.get(`ip:${day}:${ip}`)) || 0);
    if (usedIp >= perIp) return reply(429, `今日の質問回数（${perIp}回）を使い切りました。明日の0時にまた使えます。`, { ...h, 'X-Remaining': '0' });
    const usedAll = Number((await env.LIMITS.get(`all:${day}`)) || 0);
    if (usedAll >= total) return reply(429, '今日は質問が混み合い、受付を締め切りました。明日またお試しください。', { ...h, 'X-Remaining': '0' });

    const qRes = await fetch(`${env.SITE_URL}/data/q/${qid}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!qRes.ok) return reply(404, 'この問題のデータが見つかりませんでした。', h);
    const q = (await qRes.json()) as Question;

    const n = await bump(env.LIMITS, `ip:${day}:${ip}`);
    await bump(env.LIMITS, `all:${day}`);
    const remaining = String(Math.max(0, perIp - n));

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const params = {
      model: env.AI_MODEL,
      max_tokens: 4000,
      output_config: { effort: env.AI_EFFORT as 'low' | 'medium' | 'high' },
      // 問題と解説（毎回同じ）を先頭に置いてキャッシュに乗せる。続く往復は messages 側
      system: [
        { type: 'text' as const, text: SYSTEM_RULES },
        { type: 'text' as const, text: questionBlock(q), cache_control: { type: 'ephemeral' as const } },
      ],
      messages,
    };
    const stream = FALLBACK_MODELS.has(env.AI_MODEL)
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
      headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Remaining': remaining },
    });
  },
};
