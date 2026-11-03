import { useEffect, useRef, useState } from 'react';
import type { Question } from '../../lib/types';

// 「AI に質問」。中継サーバー（worker/）の URL が PUBLIC_AI_ENDPOINT に入っていれば、
// その場で AI とやりとりする。入っていなければ、従来どおり質問文をコピーして外の AI に貼る形。
const ENDPOINT: string | undefined = import.meta.env.PUBLIC_AI_ENDPOINT;

export function buildPrompt(q: Question) {
  const lines = [`【測量士試験 ${q.yearLabel} 午前 第${q.num}問（${q.category}）】`, '', q.statementText, ''];
  if (q.items.length) { lines.push(...q.items.map((i) => `${i.key}. ${i.text}`)); lines.push(''); }
  if (q.choices.length) lines.push(...q.choices.map((c) => `${c.key}. ${c.text}`));
  lines.push('', `正解：${q.answer}`, '',
    'この問題について、なぜその答えになるのかを、途中の考え方を省略せずに説明してください。',
    '誤りの選択肢についても、どこが・なぜ誤りかを述べてください。');
  return lines.join('\n');
}

type Msg = { role: 'user' | 'assistant'; content: string };

function suggestions(q: Question) {
  const s = ['この問題のポイントを3行で', '解説の分からない所をもっと噛み砕いて'];
  if (q.items.length) s.unshift(`${q.items[0].key} はなぜ正しい／誤り？`);
  if (/計算|求め|m|km|°/.test(q.statementText)) s.push('計算の途中式をもう一度ていねいに');
  return s.slice(0, 4);
}

function Chat({ q }: { q: Question }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  const ask = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    const history: Msg[] = [...msgs, { role: 'user', content: t }];
    setMsgs([...history, { role: 'assistant', content: '' }]);
    setInput(''); setBusy(true); setNotice('');
    try {
      const res = await fetch(`${ENDPOINT}/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qid: q.id, messages: history }),
      });
      const rem = res.headers.get('X-Remaining');
      if (rem !== null) setRemaining(rem);
      if (!res.ok || !res.body) {
        setNotice(await res.text());
        setMsgs(history.slice(0, -1)); // 送れなかった質問は入力欄へ戻す
        setInput(t);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setMsgs([...history, { role: 'assistant', content: acc }]);
      }
    } catch {
      setNotice('通信に失敗しました。電波の良い所でもう一度お試しください。');
      setMsgs(history.slice(0, -1)); setInput(t);
    } finally {
      setBusy(false);
    }
  };

  const full = msgs.length >= 12;
  return (
    <>
      <div className="max-h-[55vh] overflow-auto space-y-3 mb-3">
        {msgs.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestions(q).map((s) => (
              <button key={s} type="button" className="btn btn-ghost btn-sm" onClick={() => ask(s)}>{s}</button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
            <div className={'inline-block text-left text-sm whitespace-pre-wrap rounded-dojo px-3 py-2 max-w-[92%] ' +
              (m.role === 'user' ? 'bg-moss-pale' : 'bg-paper border border-line')}>
              {m.content || (busy && i === msgs.length - 1 ? '考えています…' : '')}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {notice && <p className="text-sm text-[#a33] mb-2">{notice}</p>}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input className="flex-1 border border-line rounded-dojo px-3 py-2 text-sm bg-white" maxLength={800}
          placeholder={full ? 'この問題のやりとりは上限に達しました' : '例：選択肢3はなぜ誤り？'}
          value={input} onChange={(e) => setInput(e.target.value)} disabled={busy || full} />
        <button className="btn btn-primary btn-sm" disabled={busy || full || !input.trim()}>送る</button>
      </form>
      <p className="text-[.7rem] text-ink-faint mt-2 leading-snug">
        AI の答えは誤ることがあります。正解は国土地理院の発表が正です。1日5回まで無料{remaining !== null && `（今日の残り ${remaining} 回）`}。質問の内容は回答の作成にだけ使い、保存しません。
      </p>
    </>
  );
}

function CopyPrompt({ q }: { q: Question }) {
  const [copied, setCopied] = useState(false);
  const prompt = buildPrompt(q);
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* 権限なし */ }
  };
  return (
    <>
      <p className="text-sm text-ink-soft mb-3">
        この問題について AI に追加の質問ができる機能を準備しています。いまは下の質問文をコピーして、お使いの AI（ChatGPT・Gemini・Claude など）に貼り付けてお使いください。
      </p>
      <pre className="text-xs whitespace-pre-wrap bg-paper border border-line rounded-dojo p-3 max-h-64 overflow-auto font-sans">{prompt}</pre>
      <div className="mt-3"><button className="btn btn-primary btn-sm" onClick={copy}>{copied ? 'コピーしました' : '質問文をコピー'}</button></div>
    </>
  );
}

export default function AiExplainButton({ q }: { q: Question }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        🤖 AI に質問{!ENDPOINT && <span className="text-xs text-ink-faint ml-1">（準備中）</span>}
      </button>
      {open && (
        <div className="modal-bg" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <button className="modal-x" onClick={() => setOpen(false)} aria-label="閉じる">×</button>
            <h3 className="text-lg mb-2">AI に質問（{q.yearLabel} 第{q.num}問）</h3>
            {ENDPOINT ? <Chat q={q} /> : <CopyPrompt q={q} />}
          </div>
        </div>
      )}
    </>
  );
}
