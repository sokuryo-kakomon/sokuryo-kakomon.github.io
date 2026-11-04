import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@nanostores/react';
import siteJson from '../../data/site.json';
import type { Exam, Question, QuestionIndex, Site } from '../../lib/types';
import { $progress, isWeak, recordAnswer, type Progress } from '../../store/progress';
import { $mogiTrial } from '../../store/drill';
import { $aiCode, checkPaid, type PaidState } from '../../store/ai';

// 模擬試験。過去問から本番と同じ分野の並び・同じ問題数・同じ時間で1回分を組み、最後にまとめて採点する。
// 中身は「間違えた問題」を優先して選ぶ（直近で不正解 → 要復習 → 未回答 → 正解済みの古い順）。
// 新しい問題は作らない（答えは国土地理院の解答例のまま）。
// 無料は試験ごとに「分野を1つ選んだ短い回」を1回だけ。有料プランは全28問の回も分野の回も何度でも。

const S = siteJson as unknown as Site;
// 本番の時間と合格の目安（令和8年 受験案内）。測量士は午前（択一）だけを模す
const EXAM: Record<Exam, { name: string; minutes: number; line: string }> = {
  shi: { name: '測量士（午前）', minutes: 150, line: '午前の基準は 450点（18問）以上。合格には午後と合わせて 910点以上が必要です。' },
  hoshi: { name: '測量士補', minutes: 180, line: '合格基準は 450点（18問）以上です。' },
};
const PASS = 18;
const KEY = 'sokuryo_mogi_now';

interface Run { exam: Exam; cat: string; ids: string[]; answers: Record<string, number>; start: number; limit: number }

function shuffle<T>(a: T[]) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
// 優先の段（小さいほど先に選ぶ）
function tier(prog: Progress, id: string) {
  const r = prog[id];
  if (r?.answered && !r.correct) return 0;
  if (isWeak(r)) return 1;
  if (!r?.answered) return 2;
  return 3;
}
// 本番の分野の並び = 最新年度の第1問〜第28問の分野
function slotsOf(index: QuestionIndex[], exam: Exam) {
  const ys = (exam === 'hoshi' ? S.hoshiYears : S.years).map((y) => y.id);
  const latest = ys.find((y) => index.some((x) => x.exam === exam && x.year === y))!;
  return index.filter((x) => x.exam === exam && x.year === latest).sort((a, b) => a.num - b.num).map((x) => x.categorySlug);
}
export function buildRun(index: QuestionIndex[], prog: Progress, exam: Exam, cat: string): Run {
  const all = slotsOf(index, exam);
  const slots = cat === 'all' ? all : all.filter((c) => c === cat);
  const used = new Set<string>();
  const ids = slots.map((c) => {
    const pool = shuffle(index.filter((x) => x.exam === exam && x.categorySlug === c && !used.has(x.id)));
    pool.sort((a, b) => tier(prog, a.id) - tier(prog, b.id) || (prog[a.id]?.at ?? 0) - (prog[b.id]?.at ?? 0));
    const pick = pool[0];
    used.add(pick.id);
    return pick.id;
  });
  const limit = Math.round((EXAM[exam].minutes * 60 * slots.length) / all.length);
  return { exam, cat, ids, answers: {}, start: Date.now(), limit };
}
const fmt = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function MockExam() {
  const [index, setIndex] = useState<QuestionIndex[] | null>(null);
  const [exam, setExam] = useState<Exam>('shi');
  const [cat, setCat] = useState('all');
  const [run, setRun] = useState<Run | null>(null);
  const [i, setI] = useState(0);
  const [qs, setQs] = useState<Record<string, Question>>({});
  const [graded, setGraded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [paid, setPaid] = useState<PaidState>('checking');
  const code = useStore($aiCode);
  const prog = useStore($progress);
  const trial = useStore($mogiTrial);

  useEffect(() => {
    fetch('/data/index.json').then((r) => r.json()).then(setIndex);
    if (new URLSearchParams(location.search).get('exam') === 'hoshi') setExam('hoshi');
    // 途中で閉じた回があれば続きから
    try { const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved?.ids) { setRun(saved); setExam(saved.exam); } } catch { /* 無ければ新しく */ }
  }, []);
  useEffect(() => { checkPaid(code).then(setPaid); }, [code]);
  useEffect(() => { if (run && !graded) try { localStorage.setItem(KEY, JSON.stringify(run)); } catch { /* 保存できなくても続けられる */ } }, [run, graded]);
  useEffect(() => {
    if (!run || graded) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run, graded]);
  // 問題本文は全部先に取っておく（28問で約200KB。試験中に読み込みで待たせない）
  useEffect(() => {
    if (!run) return;
    for (const id of run.ids) if (!qs[id]) fetch(`/data/q/${id}.json`).then((r) => r.json()).then((q: Question) => setQs((m) => ({ ...m, [id]: q })));
  }, [run]);

  const remain = run ? Math.max(0, Math.round((run.start + run.limit * 1000 - now) / 1000)) : 0;
  // 時間切れで採点（本文がそろってから。途中で閉じた回を開き直した時も）
  useEffect(() => { if (run && !graded && remain === 0 && run.ids.every((id) => qs[id])) grade(); }, [remain, qs]);

  const cats = useMemo(() => (index ? S.categories.filter((c) => slotsOf(index, exam).includes(c.slug)) : []), [index, exam]);
  if (!index) return <div className="card p-6 text-ink-soft">読み込み中…</div>;

  const canFull = paid === 'paid';
  const canCat = paid === 'paid' || !trial[exam];
  const begin = () => {
    if (cat === 'all' ? !canFull : !canCat) return;
    if (paid !== 'paid') $mogiTrial.set({ ...$mogiTrial.get(), [exam]: true });
    setRun(buildRun(index, prog, exam, cat)); setI(0); setGraded(false); setNow(Date.now()); window.scrollTo(0, 0);
  };
  function grade() {
    if (!run) return;
    for (const id of run.ids) {
      const a = run.answers[id];
      const q = qs[id];
      if (a && q) recordAnswer(id, a, q.answer);
    }
    setGraded(true);
    try { localStorage.removeItem(KEY); } catch { /* 無くてよい */ }
    window.scrollTo(0, 0);
  }
  const quit = () => { setRun(null); setGraded(false); try { localStorage.removeItem(KEY); } catch { /* 無くてよい */ } };

  // ---------- 採点 ----------
  if (run && graded) {
    const ok = run.ids.filter((id) => qs[id] && run.answers[id] === qs[id].answer);
    const full = run.cat === 'all';
    const byCat = S.categories.map((c) => {
      const ids = run.ids.filter((id) => qs[id]?.categorySlug === c.slug);
      return { c, n: ids.length, ok: ids.filter((id) => ok.includes(id)).length };
    }).filter((r) => r.n > 0);
    return (
      <div className="space-y-5">
        <div className="card p-6 text-center">
          <div className="eyebrow mb-2">{EXAM[run.exam].name} 模擬試験の結果</div>
          <div className="serif text-5xl text-moss-deep">{ok.length}<span className="text-2xl text-ink-soft"> / {run.ids.length}問</span></div>
          <div className="text-ink-soft mt-1">{ok.length * 25}点 / {run.ids.length * 25}点</div>
          {full && (
            <div className={'inline-block mt-3 px-4 py-2 rounded-dojo font-bold ' + (ok.length >= PASS ? 'bg-moss-pale text-moss-deep' : 'bg-shu-pale text-shu')}>
              {ok.length >= PASS ? `基準の ${PASS}問 に届いています` : `基準の ${PASS}問 まで あと ${PASS - ok.length}問`}
            </div>
          )}
          <p className="text-xs text-ink-faint mt-2">{EXAM[run.exam].line} 過去問の組み直しなので、本番の点数を約束するものではありません。</p>
          <div className="flex flex-wrap justify-center gap-2 mt-5">
            <button className="btn btn-primary" onClick={quit}>もう1回分つくる</button>
            <a className="btn btn-ghost" href="/progress/">成績表を見る</a>
          </div>
        </div>
        <div className="card p-5">
          <h2 className="text-lg mb-3">分野別</h2>
          <div className="space-y-2">
            {byCat.map(({ c, n, ok: k }) => (
              <div key={c.slug} className="grid grid-cols-[8.5rem_1fr_4rem] items-center gap-3 text-sm">
                <span>{c.icon} {c.name}</span>
                <div className="bar"><i style={{ width: (k / n) * 100 + '%' }} /></div>
                <span className="text-right text-ink-soft">{k}/{n}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card p-5">
          <h2 className="text-lg mb-3">1問ずつ（解説は問題のページで）</h2>
          <ul className="divide-y divide-line">
            {run.ids.map((id, k) => {
              const q = qs[id]; const a = run.answers[id];
              return (
                <li key={id} className="py-2 text-sm flex gap-3 items-baseline">
                  <span className={'w-6 shrink-0 font-bold ' + (q && a === q.answer ? 'text-moss-deep' : 'text-shu')}>{q && a === q.answer ? '○' : '×'}</span>
                  <span className="w-10 shrink-0 text-ink-soft">{k + 1}.</span>
                  <a href={q?.url} className="shrink-0 no-underline">{q?.yearLabel} 第{q?.num}問</a>
                  <span className="text-ink-soft min-w-0 truncate">あなた {a ?? '—'} ／ 正解 {q?.answer}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    );
  }

  // ---------- 受験中 ----------
  if (run) {
    const id = run.ids[i];
    const q = qs[id];
    const n = Object.keys(run.answers).length;
    const choose = (v: number) => setRun({ ...run, answers: { ...run.answers, [id]: v } });
    const picked = run.answers[id];
    return (
      <div className="space-y-4">
        <div className="card px-4 py-3 flex flex-wrap items-center gap-3 text-sm sticky top-16 z-10">
          <span className="serif text-lg">{i + 1} <span className="text-ink-faint text-sm">/ {run.ids.length}</span></span>
          <span className="text-ink-soft">解答済み {n}</span>
          <span className={'ml-auto font-mono text-base ' + (remain < 600 ? 'text-shu font-bold' : '')}>残り {fmt(remain)}</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { if (n === run.ids.length || confirm(`まだ ${run.ids.length - n}問 答えていません。採点しますか？`)) grade(); }}>採点する</button>
        </div>
        <div className="flex flex-wrap gap-1">
          {run.ids.map((x, k) => (
            <button key={x} type="button" onClick={() => { setI(k); window.scrollTo(0, 0); }}
              className={'w-8 h-8 text-xs rounded-dojo border ' + (k === i ? 'border-moss font-bold ' : 'border-line ') + (run.answers[x] ? 'bg-moss-pale' : 'bg-card')}>{k + 1}</button>
          ))}
        </div>
        {q ? (
          <article className="card p-5 md:p-7">
            <div className="text-xs text-ink-faint mb-2">第{i + 1}問 ・ {q.categoryIcon} {q.category}（出典は採点のあとに出ます）</div>
            <div className="qhtml">
              <p className="text-[1.04rem]" dangerouslySetInnerHTML={{ __html: q.statementHtml }} />
              {q.tablesHtml.map((t, k) => <div key={k} dangerouslySetInnerHTML={{ __html: t }} />)}
              {q.figure?.essential && <img src={q.figure.src} alt={`第${i + 1}問の図表`} className="my-3 max-w-full h-auto border border-line rounded-dojo bg-white" />}
              {q.items.length > 0 && (
                <div className="my-3 space-y-1.5">
                  {q.items.map((it) => (
                    <div key={it.key} className="flex gap-2 px-3 py-2 bg-paper rounded-dojo text-[.97rem] text-ink-soft">
                      <b className="text-ink shrink-0">{it.key}．</b><span dangerouslySetInnerHTML={{ __html: it.html }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4">
              {q.choiceStyle === 'sentence' && q.choices.map((c) => (
                <button key={c.key} type="button" className={'choice' + (picked === c.value ? ' is-picked' : '')} onClick={() => choose(c.value)}>
                  <span className="mark">{picked === c.value ? '●' : ''}</span>
                  <span><b className="mr-1">{c.key}．</b><span dangerouslySetInnerHTML={{ __html: c.html }} /></span>
                </button>
              ))}
              {q.choiceStyle === 'combo' && (
                <div className="flex flex-wrap">
                  {q.choices.map((c) => (
                    <button key={c.key} type="button" className={'choice choice-combo' + (picked === c.value ? ' is-picked' : '')} onClick={() => choose(c.value)}>
                      <span className="mark">{picked === c.value ? '●' : ''}</span>
                      <span><b className="mr-1">{c.key}.</b><span dangerouslySetInnerHTML={{ __html: c.html }} /></span>
                    </button>
                  ))}
                </div>
              )}
              {q.choiceStyle === 'none' && (
                <div className="flex flex-wrap gap-2">
                  {[1, 2, 3, 4, 5].map((v) => <button key={v} type="button" className={'choice choice-num' + (picked === v ? ' is-picked' : '')} onClick={() => choose(v)}>{v}</button>)}
                </div>
              )}
            </div>
          </article>
        ) : <div className="card p-6 text-ink-soft">読み込み中…</div>}
        <div className="flex justify-between gap-3">
          <button type="button" className="btn btn-ghost flex-1" disabled={i === 0} onClick={() => { setI(i - 1); window.scrollTo(0, 0); }}>← 前の問題</button>
          <button type="button" className="btn btn-ghost flex-1" disabled={i === run.ids.length - 1} onClick={() => { setI(i + 1); window.scrollTo(0, 0); }}>次の問題 →</button>
        </div>
        <div className="text-center"><button type="button" className="text-xs text-ink-faint underline" onClick={() => { if (confirm('この回をやめます（記録には残りません）。')) quit(); }}>この回をやめる</button></div>
      </div>
    );
  }

  // ---------- 条件選択 ----------
  const sel = 'px-3 py-1.5 rounded-dojo border text-sm cursor-pointer transition ';
  const on = 'bg-moss text-white border-moss';
  const off = 'bg-card border-line hover:border-ink-faint';
  const slots = slotsOf(index, exam);
  const n = cat === 'all' ? slots.length : slots.filter((c) => c === cat).length;
  const minutes = Math.round((EXAM[exam].minutes * n) / slots.length);
  const allowed = cat === 'all' ? canFull : canCat;
  const weakN = index.filter((x) => x.exam === exam && tier(prog, x.id) <= 1).length;
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="font-bold mb-2">試験</div>
        <div className="flex flex-wrap gap-2 mb-5">
          {(['shi', 'hoshi'] as Exam[]).map((e) => <button key={e} className={sel + (exam === e ? on : off)} onClick={() => { setExam(e); setCat('all'); }}>{EXAM[e].name}</button>)}
        </div>
        <div className="font-bold mb-2">範囲</div>
        <div className="flex flex-wrap gap-2">
          <button className={sel + (cat === 'all' ? on : off)} onClick={() => setCat('all')}>本番と同じ 全{slots.length}問</button>
          {cats.map((c) => <button key={c.slug} className={sel + (cat === c.slug ? on : off)} onClick={() => setCat(c.slug)}>{c.icon} {c.name}だけ</button>)}
        </div>
        <p className="text-xs text-ink-faint mt-3">
          本番と同じ分野の並びで、過去問から1回分を組みます。間違えた問題・要復習の問題（いま {weakN}問）を先に入れ、足りない分を未回答、解けた問題の順に足します。
          途中では正誤を出さず、最後にまとめて採点します。
        </p>
      </div>
      <div className="card p-5 flex flex-wrap items-center gap-4">
        <div className="serif text-3xl">{n}<span className="text-base text-ink-soft"> 問 ・ {minutes}分</span></div>
        <button className="btn btn-primary text-lg px-8" disabled={!allowed || paid === 'checking'} onClick={begin}>始める</button>
        <span className="text-sm text-ink-soft">
          {paid === 'paid' ? '有料プラン：何回でも'
            : cat === 'all' ? <>全{slots.length}問の回は有料プラン（月額980円）です。<a href="/ai/">有料プランを見る →</a> 無料では分野を1つ選んだ回を1回試せます。</>
            : canCat ? '無料のお試し（この試験で1回だけ）'
            : <>無料のお試しは使いました。<a href="/ai/">有料プランを見る →</a></>}
        </span>
      </div>
    </div>
  );
}
