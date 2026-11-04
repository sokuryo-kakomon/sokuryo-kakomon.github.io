import type { Question } from './types';

// 一問一答（肢ごとの○×）の材料を、解説の <div class="opt correct|wrong">a. 正しい。…</div> から作る。
// ビルド時専用。新しい問題を作るのではなく、解説で正誤を確かめ済みの肢だけを抜き出す。
// 出さないもの:
//  - 規則の改正の札がある問題（今の規則と正誤が変わり得る）
//  - 図・表を見ないと判断できない問題（地図の読み取りなど）
//  - 選択肢そのものが組合せ（「a と c」など）の問題
//  - 札（correct/wrong）と見出し（正しい／誤り）が食い違う肢（「消去できる」など正誤でない書き方）

export interface OxItem {
  id: string; q: string; exam: 'shi' | 'hoshi'; cat: string; key: string; ok: boolean;
  stem: string; html: string; reasonHtml: string; url: string; label: string;
}

const OPT = /<div class="opt (correct|wrong)">\s*([a-eア-オ1-5])\s*[.．、]\s*([\s\S]*?)<\/div>/g;
const strip = (h: string) => h.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// 問題文の頭（「次の文は、〜について述べたものである。」まで）。肢だけでは何の話か分からないので添える
function stemOf(q: Question) {
  const t = q.statementText;
  const i = t.indexOf('。');
  return i > 0 && i < 140 ? t.slice(0, i + 1) : t.slice(0, 120) + '…';
}

export function oxItems(qs: Question[]): OxItem[] {
  const out: OxItem[] = [];
  for (const q of qs) {
    const h = q.explanationHtml;
    if (h.includes('class="notice"')) continue;
    if (q.figure?.essential || q.tablesHtml.length) continue;
    if (q.choiceStyle === 'combo' && !q.items.length) continue;
    const src = new Map((q.items.length ? q.items : q.choices).map((x) => [x.key, x.html] as [string | null, string]));
    const ms = [...h.matchAll(OPT)];
    ms.forEach((m, k) => {
      const [, cls, key, head] = m;
      if (!src.has(key)) return;
      const ok = /^正/.test(strip(head));
      const ng = /^誤/.test(strip(head));
      if (!(ok || ng) || (cls === 'correct') !== ok) return;
      const from = m.index! + m[0].length;
      const next = ms[k + 1]?.index ?? h.indexOf('<div class="conc">', from);
      const rest = head.trim().replace(/^\s*(正しい|誤り|誤っている|正)[。．、]?\s*/, '');
      const reasonHtml = ((strip(rest) ? `<p>${rest}</p>` : '') + h.slice(from, next < 0 ? h.length : next)).trim();
      out.push({
        id: `${q.id}-${key}`, q: q.id, exam: q.exam ?? 'shi', cat: q.categorySlug, key, ok: cls === 'correct',
        stem: stemOf(q), html: src.get(key)!, reasonHtml, url: q.url,
        label: `${q.exam === 'hoshi' ? '測量士補 ' : '測量士 '}${q.yearLabel} 第${q.num}問 ${key}`,
      });
    });
  }
  return out;
}
