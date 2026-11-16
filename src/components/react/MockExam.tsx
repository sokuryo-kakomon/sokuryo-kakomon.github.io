import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@nanostores/react';
import siteJson from '../../data/site.json';
import type { Exam, Question, QuestionIndex, Site } from '../../lib/types';
import { $progress, isWeak, recordAnswer, type Progress, needsReview } from '../../store/progress';
import { showExam } from '../../lib/examui';

// 模擬試験。年度を選んで、その年度の問題を第1問から順に、本番と同じ時間で解き、最後にまとめて採点する（無料で何回でも）。
// 「間違えた問題だけ」も無料（直近で不正解を先に、その中で古い順に、最大28問）。
// 新しい問題は作らない（答えは国土地理院の解答例のまま）。

const S = siteJson as unknown as Site;
// 本番の時間と合格の目安（令和8年 受験案内）。測量士は午前（択一）だけを模す
const EXAM: Record<Exam, { name: string; minutes: number; line: string }> = {
  shi: { name: '測量士（午前）', minutes: 150, line: '午前の基準は 450点（18問）以上。合格には午後と合わせて 910点以上が必要です。' },
  hoshi: { name: '測量士補', minutes: 180, line: '合格基準は 450点（18問）以上です。' },
};
const PASS = 18;
const FULL = 28; // 本番の問題数（時間はこの割合で）
const KEY = 'sokuryo_mogi_now';

interface Run { exam: Exam; cat: string; ids: string[]; answers: Record<string, number>; start: number; limit: number; last?: number }
// 続きから開く問題：最後に答えた問題の次。そこが答え済み・最後を越える時は最初の未回答（全部答えていれば最後に答えた問題）
function resumeAt(r: Run) {
  const firstOpen = r.ids.findIndex((id) => !r.answers[id]);
  if (r.last == null) return Math.max(0, firstOpen);
  const nx = r.last + 1;
  if (nx < r.ids.length && !r.answers[r.ids[nx]]) return nx;
  return firstOpen >= 0 ? firstOpen : r.last;
}

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
  // 年度ごと（無料）: その年度の問題を順に、本番と同じ時間で
  if (cat.startsWith('y:')) {
    const ids = index.filter((x) => x.exam === exam && x.year === cat.slice(2)).sort((a, b) => a.num - b.num).map((x) => x.id);
    return { exam, cat, ids, answers: {}, start: Date.now(), limit: Math.round((EXAM[exam].minutes * 60 * ids.length) / FULL) };
  }
  // 間違えた問題だけ（無料）: 直近で不正解を先に、その中で古い順に、本番の問題数まで
  if (cat === 'weak') {
    const ids = shuffle(index.filter((x) => x.exam === exam && needsReview(prog[x.id])))
      .sort((a, b) => tier(prog, a.id) - tier(prog, b.id) || (prog[a.id]?.at ?? 0) - (prog[b.id]?.at ?? 0)).slice(0, all.length).map((x) => x.id);
    return { exam, cat, ids, answers: {}, start: Date.now(), limit: Math.round((EXAM[exam].minutes * 60 * ids.length) / all.length) };
  }
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
  // 途中で閉じた回（すぐには再開せず、先に「前回の続き」の札を出す）
  const [pending, setPending] = useState<Run | null>(null);
  const [i, setI] = useState(0);
  const [qs, setQs] = useState<Record<string, Question>>({});
  const [graded, setGraded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const prog = useStore($progress);

  useEffect(() => {
    fetch('/data/index.json').then((r) => r.json()).then(setIndex);
    if (new URLSearchParams(location.search).get('exam') === 'hoshi') setExam('hoshi');
    const sp = new URLSearchParams(location.search);
    if (sp.get('range') === 'weak') setCat('weak');
    if (sp.get('year')) setCat('y:' + sp.get('year'));
    // 途中で閉じた回があれば、先に札を出して選ばせる（前の作りの「分野の回・全28問の回」は続きが無いので捨てる）
    // ?exam= で別の試験を開いた時は、その試験の選ぶ画面を出し、もう一方の回は消さずに小さく知らせるだけ
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved?.ids && (saved.cat === 'weak' || String(saved.cat).startsWith('y:'))) {
        setPending(saved);
        // ?exam=hoshi で測量士補を開いたのに測量士の回が残っている時だけ、選ぶ画面を出す（?exam が無ければ回の試験に合わせる）
        if (new URLSearchParams(location.search).get('exam') !== 'hoshi') { setExam(saved.exam); showExam(saved.exam); }
        if (saved.exam === 'hoshi' || new URLSearchParams(location.search).get('exam') !== 'hoshi') setCat(saved.cat);
      }
      else if (saved) localStorage.removeItem(KEY);
    } catch { /* 無ければ新しく */ }
  }, []);
  // 解いている間だけ印を付ける（下の案内を隠す）
  useEffect(() => {
    const on = !!run && !graded;
    if (on) document.documentElement.dataset.mogi = ''; else delete document.documentElement.dataset.mogi;
    return () => { delete document.documentElement.dataset.mogi; };
  }, [run, graded]);
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

  const ys = (exam === 'hoshi' ? S.hoshiYears ?? [] : S.years).filter((y) => index.some((x) => x.exam === exam && x.year === y.id));
  // 選んでいる物（年度が未選択・この試験に無い年度なら最新の年度）
  const cc = cat === 'weak' || (cat.startsWith('y:') && ys.some((y) => 'y:' + y.id === cat)) ? cat : 'y:' + ys[0].id;
  const begin = () => {
    setPending(null);
    setRun(buildRun(index, prog, exam, cc)); setI(0); setGraded(false); setNow(Date.now()); window.scrollTo(0, 0);
  };
  const resume = (r: Run) => {
    setPending(null); setExam(r.exam); showExam(r.exam);
    setRun(r); setI(resumeAt(r)); setGraded(false); setNow(Date.now()); window.scrollTo(0, 0);
  };
  const runName = (r: Run) => {
    const y = (r.exam === 'hoshi' ? S.hoshiYears ?? [] : S.years).find((v) => 'y:' + v.id === r.cat);
    return `${EXAM[r.exam].name.replace(/（.*）/, '')} ${r.cat === 'weak' ? '間違えた問題' : y?.label ?? ''}`;
  };
  const leftOf = (r: Run) => Math.max(0, Math.round((r.start + r.limit * 1000 - Date.now()) / 1000));
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
    const full = run.cat.startsWith('y:');
    const yName = full ? ys.find((y) => 'y:' + y.id === run.cat)?.label ?? '' : '間違えた問題の解き直し';
    const byCat = S.categories.map((c) => {
      const ids = run.ids.filter((id) => qs[id]?.categorySlug === c.slug);
      return { c, n: ids.length, ok: ids.filter((id) => ok.includes(id)).length };
    }).filter((r) => r.n > 0);
    return (
      <div className="space-y-5">
        <div className="card p-6 text-center">
          <div className="eyebrow mb-2">{EXAM[run.exam].name} {yName}の結果</div>
          <div className="serif text-5xl text-moss-deep">{ok.length}<span className="text-2xl text-ink-soft"> / {run.ids.length}問</span></div>
          <div className="text-ink-soft mt-1">{ok.length * 25}点 / {run.ids.length * 25}点</div>
          {full && (
            <div className={'inline-block mt-3 px-4 py-2 rounded-dojo font-bold ' + (ok.length >= PASS ? 'bg-moss-pale text-moss-deep' : 'bg-shu-pale text-shu')}>
              {ok.length >= PASS ? `基準の ${PASS}問 に届いています` : `基準の ${PASS}問 まで あと ${PASS - ok.length}問`}
            </div>
          )}
          <p className="text-xs text-ink-faint mt-2">{EXAM[run.exam].line} {full ? 'その年度の問題を本番と同じ時間で解いた結果です。' : '過去問の組み直しなので、本番の点数を約束するものではありません。'}</p>
          <div className="flex flex-wrap justify-center gap-2 mt-5">
            <button className="btn btn-primary" onClick={quit}>ほかの年度を解く</button>
            {run.ids.length - ok.length > 0 && <button className="btn btn-ghost" onClick={() => { quit(); setCat('weak'); }}>間違えた問題を解き直す</button>}
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
    const choose = (v: number) => setRun({ ...run, answers: { ...run.answers, [id]: v }, last: i });
    const picked = run.answers[id];
    // 次へ・番号を押したら、ページの頭でなく問題の頭へ（上の帯の下）
    const toQ = () => setTimeout(() => { const el = document.getElementById('mogi-q'); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 130); }, 0);
    const numBtns = (after?: () => void) => run.ids.map((x, k) => (
      <button key={x} type="button" onClick={() => { setI(k); after?.(); toQ(); }} aria-label={`第${k + 1}問${run.answers[x] ? '（解答済み）' : ''}`}
        className={'min-w-10 h-10 px-1 text-sm rounded-dojo border ' + (k === i ? 'border-moss font-bold ' : 'border-line ') + (run.answers[x] ? 'bg-moss text-white border-moss' : 'bg-card')}>{k + 1}</button>
    ));
    return (
      <div className="space-y-4">
        <div className="card px-3 py-2 md:px-4 md:py-3 flex items-center gap-3 text-sm sticky top-14 md:top-16 z-10">
          <span className="serif text-lg whitespace-nowrap">{i + 1} <span className="text-ink-faint text-sm">/ {run.ids.length}</span></span>
          <span className="text-ink-soft text-xs leading-tight">{EXAM[run.exam].name.replace(/（.*）/, '')}・{run.cat === 'weak' ? '間違えた問題' : ys.find((y) => 'y:' + y.id === run.cat)?.label}<span className="hidden sm:inline">・解答済み {n}</span></span>
          <span className={'ml-auto font-mono text-base whitespace-nowrap ' + (remain < 600 ? 'text-shu font-bold' : '')}>残り {fmt(remain)}</span>
          <button type="button" className="btn btn-primary btn-sm whitespace-nowrap shrink-0" onClick={() => { if (n === run.ids.length || confirm(`まだ ${run.ids.length - n}問 答えていません。採点しますか？`)) grade(); }}>採点する</button>
        </div>
        <p className="text-xs text-ink-faint -mt-2">⏱ 閉じている間も時間は進みます</p>
        {/* 番号の一覧：スマホでは畳む（4段の番号が第1問を押し下げるため）。広い画面は今のまま並べる */}
        <details className="md:hidden card px-3 py-2" id="mogi-nums">
          <summary className="cursor-pointer text-sm font-bold text-moss select-none">問題の一覧（解答済み {n}/{run.ids.length}）</summary>
          <div className="flex flex-wrap gap-1 mt-2">{numBtns(() => { const d = document.getElementById('mogi-nums') as HTMLDetailsElement | null; if (d) d.open = false; })}</div>
        </details>
        <div className="hidden md:flex flex-wrap gap-1">{numBtns()}</div>
        {q ? (
          <article id="mogi-q" className="card p-5 md:p-7">
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
                <button key={c.key} type="button" className={'choice' + (picked === c.value ? ' is-picked' : '')} onClick={() => choose(c.value)} aria-label={`選択肢${c.key}：${c.text}`} aria-pressed={picked === c.value}>
                  <span className="mark">{picked === c.value ? '●' : ''}</span>
                  <span className="choice-body"><span className="choice-no" aria-hidden="true">{c.key}</span><span dangerouslySetInnerHTML={{ __html: c.html }} /></span>
                </button>
              ))}
              {q.choiceStyle === 'combo' && (
                <div className="flex flex-wrap">
                  {q.choices.map((c) => (
                    <button key={c.key} type="button" className={'choice choice-combo' + (picked === c.value ? ' is-picked' : '')} onClick={() => choose(c.value)} aria-label={`選択肢${c.key}：${c.text}`} aria-pressed={picked === c.value}>
                      <span className="mark">{picked === c.value ? '●' : ''}</span>
                      <span className="choice-body"><span className="choice-no" aria-hidden="true">{c.key}</span><span dangerouslySetInnerHTML={{ __html: c.html }} /></span>
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
          <button type="button" className="btn btn-ghost flex-1" disabled={i === 0} onClick={() => { setI(i - 1); toQ(); }}>← 前の問題</button>
          <button type="button" className="btn btn-primary flex-1" disabled={i === run.ids.length - 1} onClick={() => { setI(i + 1); toQ(); }}>次の問題 →</button>
        </div>
        <div className="text-center"><button type="button" className="btn btn-ghost btn-sm min-h-10 text-ink-soft" onClick={() => { if (confirm('この回をやめます（記録には残りません）。')) quit(); }}>この回をやめる</button></div>
      </div>
    );
  }

  // ---------- 年度を選ぶ ----------
  // 試験は左の欄で決まる。年度を押すと、すぐ下の「始める」が その年度に変わる（スマホでは画面の下に貼り付く）
  const MIN = EXAM[exam].minutes;
  const weakN = index.filter((x) => x.exam === exam && needsReview(prog[x.id])).length;
  const yLabel = ys.find((y) => 'y:' + y.id === cc)?.label ?? '';
  const n = cc === 'weak' ? Math.min(weakN, FULL) : index.filter((x) => x.exam === exam && 'y:' + x.year === cc).length;
  const minutes = Math.round((MIN * n) / FULL);
  const other: Exam = exam === 'shi' ? 'hoshi' : 'shi';
  const tile = 'text-left rounded-dojo border px-4 py-3 transition ';
  const on = 'bg-moss text-white border-moss';
  const off = 'bg-card border-line hover:border-ink-faint';
  const pend = pending && pending.exam === exam ? pending : null;
  const pendOther = pending && pending.exam !== exam ? pending : null;
  return (
    <div className="space-y-5">
      {pend && (() => { const left = leftOf(pend); const k = Object.keys(pend.answers).length; return (
        <div className="card p-5 border-2 border-moss">
          <div className="font-bold text-lg mb-1">前回の続きがあります</div>
          <p className="text-[.95rem] mb-3">{runName(pend)} ・ 解答済み {k}/{pend.ids.length}問 ・ {left > 0 ? `残り ${Math.floor(left / 3600)}:${String(Math.floor((left % 3600) / 60)).padStart(2, '0')}` : '時間切れ（開くと採点します）'}</p>
          <p className="text-xs text-ink-faint -mt-2 mb-3">⏱ 閉じている間も時間は進みます。続きは、最後に答えた問題の次から開きます。</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary text-base px-6" onClick={() => resume(pend)}>続きから解く</button>
            <button type="button" className="btn btn-ghost" onClick={() => { if (confirm('前回の回をやめて、選び直します（記録には残りません）。')) { quit(); setPending(null); } }}>やめて選び直す</button>
          </div>
        </div>
      ); })()}
      <div className="card p-5">
        {pendOther && (
          <p className="text-sm text-ink-soft mb-3 pb-3 border-b border-line">{runName(pendOther)}の途中の回が残っています（解答済み {Object.keys(pendOther.answers).length}問）。<button type="button" className="text-moss underline" onClick={() => resume(pendOther)}>そちらの続きから解く</button><span className="text-xs">　※ ここで新しく始めると、その回は消えます。</span></p>
        )}
        <div className="lg:hidden flex flex-wrap items-baseline justify-between gap-2 mb-3 text-sm">
          <span className="font-bold">{EXAM[exam].name}の模擬試験</span>
          <button type="button" className="text-moss underline" onClick={() => { setExam(other); setCat('all'); showExam(other); }}>{EXAM[other].name.replace(/（.*）/, '')}に切り替える</button>
        </div>
        <div className="font-bold mb-1">年度を選ぶ</div>
        <p className="text-sm text-ink-soft mb-3">その年度の問題を第1問から順に、本番と同じ時間（28問なら{MIN}分）で解きます。途中では正誤を出さず、最後にまとめて採点します。無料で何回でも使えます。</p>
        <div className="grid gap-2 grid-cols-2 lg:grid-cols-3">
          {ys.map((y) => { const k = index.filter((x) => x.exam === exam && x.year === y.id).length; return (
            <button key={y.id} type="button" className={tile + (cc === 'y:' + y.id ? on : off)} onClick={() => setCat('y:' + y.id)}>
              <div className="font-bold">{y.label}</div>
              <div className="text-xs opacity-80">{k}問 ・ {Math.round((MIN * k) / FULL)}分</div>
            </button>
          ); })}
          <button type="button" className={tile + 'col-span-2 lg:col-span-3 ' + (cc === 'weak' ? on : off)} onClick={() => setCat('weak')}>
            <div className="font-bold">❗ 間違えた問題だけ</div>
            <div className="text-xs opacity-80">間違えた問題・要復習（いま {weakN}問）を、間違えた問題を先に、古い順に最大{FULL}問</div>
          </button>
        </div>
        <p className="text-xs text-ink-soft mt-2">{cc === 'weak' ? '選んだら、下の「間違えた問題を始める」を押します。' : `年度を選んで、下の「${yLabel}を始める」を押します。`}</p>
        <div className="sticky bottom-0 -mx-5 -mb-5 mt-4 px-5 py-3 bg-card/95 backdrop-blur border-t border-line rounded-b-dojo flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary text-base px-6 flex-1 sm:flex-none" disabled={n === 0} onClick={begin}>
            {cc === 'weak' ? '間違えた問題' : yLabel}を始める（{n}問・{minutes}分）
          </button>
          {cc === 'weak' && n === 0 && <span className="text-sm text-ink-soft">間違えた問題はいまありません。</span>}
        </div>
      </div>
    </div>
  );
}
