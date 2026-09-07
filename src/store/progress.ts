import { persistentAtom } from '@nanostores/persistent';

// 学習記録。旧サイトと同じ localStorage キー・同じ記録形式なので、
// 作り替え前に解いた分の進捗はそのまま引き継がれる。
//
// 将来ユーザー認証を入れてクラウド同期する場合は、この store を唯一の書き口として
// onProgressChange() で変更を拾い、ログイン中なら送信する形にする。
// コンポーネント側は store しか見ないので、同期先が増えても触らずに済む。

export interface Rec {
  answered: boolean;
  correct: boolean;       // 直近の解答が正解か
  userAnswer: number;
  correctAnswer: number;
  ngCount: number;        // 通算で間違えた回数
  okStreak: number;       // 連続正解数（間違えると 0 に戻る）
  attempts: number;
  at?: number;            // 直近の解答時刻（新サイトから追加。旧記録には無い）
}
export type Progress = Record<string, Rec>;

const codec = {
  encode: JSON.stringify,
  decode: (s: string) => { try { return JSON.parse(s); } catch { return undefined; } },
};

export const $progress = persistentAtom<Progress>('sokuryo_q_v2', {}, codec);
export const $bookmarks = persistentAtom<string[]>('sokuryo_bm_v1', [], codec);

export function recordAnswer(qid: string, userAnswer: number, correctAnswer: number): Rec {
  const prev = $progress.get()[qid];
  const ok = userAnswer === correctAnswer;
  const rec: Rec = {
    answered: true,
    correct: ok,
    userAnswer,
    correctAnswer,
    ngCount: (prev?.ngCount || 0) + (ok ? 0 : 1),
    okStreak: ok ? (prev?.okStreak || 0) + 1 : 0,
    attempts: (prev?.attempts || 0) + 1,
    at: Date.now(),
  };
  $progress.set({ ...$progress.get(), [qid]: rec });
  return rec;
}

export function resetProgress() {
  $progress.set({});
  $bookmarks.set([]);
}

export function toggleBookmark(qid: string) {
  const b = $bookmarks.get();
  $bookmarks.set(b.includes(qid) ? b.filter((x) => x !== qid) : [...b, qid]);
}

// 要復習 = 一度でも間違えていて、まだ 2 回連続で正解できていない
export const isWeak = (r?: Rec) => !!r && r.ngCount > 0 && r.okStreak < 2;

export function summarize(ids: string[], prog: Progress) {
  let answered = 0, correct = 0, weak = 0;
  for (const id of ids) {
    const r = prog[id];
    if (r?.answered) { answered++; if (r.correct) correct++; }
    if (isWeak(r)) weak++;
  }
  return {
    total: ids.length, answered, correct, wrong: answered - correct, weak,
    rate: answered ? Math.round((correct / answered) * 100) : 0,
    coverage: ids.length ? Math.round((answered / ids.length) * 100) : 0,
  };
}

export function onProgressChange(fn: (p: Progress) => void) {
  return $progress.listen(fn);
}
