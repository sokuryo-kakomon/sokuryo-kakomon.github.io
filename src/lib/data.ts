import questionsJson from '../data/questions.json';
import siteJson from '../data/site.json';
import guidesJson from '../data/guides.json';
import pagesJson from '../data/pages.json';
import type { Question, Site, Guides, StaticPage, QuestionIndex } from './types';

// サーバー側（ビルド時）専用。React の island からは import しない
// （questions.json は 700KB あり、クライアントへ丸ごと送りたくない）。

export const SITE_NAME = '測量士過去問';
export const SITE_TAGLINE = '測量士試験（午前・択一）4年分112問の演習と解説';

export const questions = questionsJson as Question[];
export const site = siteJson as Site;
export const guides = guidesJson as Guides;
export const pages = pagesJson as Record<'about' | 'privacy', StaticPage>;

export const years = site.years;
export const categories = site.categories;
export const byId = new Map(questions.map((q) => [q.id, q]));

export const ofYear = (y: string) => questions.filter((q) => q.year === y);
export const ofCategory = (slug: string) => questions.filter((q) => q.categorySlug === slug);
export const yearById = (y: string) => years.find((x) => x.id === y)!;
export const categoryBySlug = (s: string) => categories.find((c) => c.slug === s);

export function toIndex(q: Question): QuestionIndex {
  return {
    id: q.id, year: q.year, num: q.num, category: q.category, categorySlug: q.categorySlug,
    excerpt: q.statementText.slice(0, 64), url: q.url,
  };
}

export function pageTitle(t: string) { return `${t}｜${SITE_NAME}`; }
