import type { Language } from './protocol';
import { z } from 'zod';

export const matches = ['https://www.acmicpc.net/*', 'https://acmicpc.net/*'] as const;

export function siteUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return url && ['https://acmicpc.net', 'https://www.acmicpc.net'].includes(url.origin) ? url : null;
}

export const problemSchema = z.object({
  problemId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  url: z.string(),
  accountContext: z.string().regex(/^[a-zA-Z0-9_]{1,50}$/).nullable(),
  samples: z.array(z.object({ id: z.string(), input: z.string(), expectedOutput: z.string() })).max(20),
});

export type Problem = z.infer<typeof problemSchema>;

export function account(document: Document, url: URL) {
  // The authenticated header's logout control and account link must agree.
  const logout = document.querySelector<HTMLAnchorElement>('a[href^="/logout"]');
  const profile = logout?.closest('ul')?.querySelector<HTMLAnchorElement>('a[href^="/user/"]');
  const match = profile && siteUrl(new URL(profile.getAttribute('href')!, url).href)?.pathname.match(/^\/user\/([a-zA-Z0-9_]{1,50})$/);
  return match?.[1]?.toLowerCase() ?? null;
}

export function parseProblem(document: Document, location: string): Problem | null {
  const url = siteUrl(location);
  const id = url?.pathname.match(/^\/problem\/([1-9]\d*)\/?$/)?.[1];
  if (!url || !id || url.searchParams.has('contest_id')) return null;
  const title = document.querySelector('#problem_title')?.textContent?.trim();
  const inputs = [...document.querySelectorAll('pre[id^="sample-input-"]')];
  const outputs = document.querySelectorAll('pre[id^="sample-output-"]');
  if (!title || inputs.length !== outputs.length) throw new Error('BOJ_PARSING_FAILED');
  const samples = inputs.map((input) => {
    const sampleId = input.id.match(/^sample-input-(\d+)$/)?.[1];
    const output = sampleId && document.getElementById(`sample-output-${sampleId}`);
    if (!sampleId || !output || output.tagName !== 'PRE') throw new Error('BOJ_PARSING_FAILED');
    return { id: sampleId, input: input.textContent ?? '', expectedOutput: output.textContent ?? '' };
  });
  return problemSchema.parse({ problemId: Number(id), title, url: `${url.origin}/problem/${id}`, accountContext: account(document, url), samples });
}

export const statusSchema = z.object({
  submissionId: z.string().regex(/^[1-9]\d{0,18}$/),
  accountContext: z.string().regex(/^[a-zA-Z0-9_]{1,50}$/),
  problemId: z.number().int().positive(),
  rawVerdict: z.string().max(500),
  language: z.string().max(100),
  submittedAt: z.string().nullable(),
  memoryKb: z.number().int().nonnegative().nullable(),
  executionTimeMs: z.number().int().nonnegative().nullable(),
});

export type Status = z.infer<typeof statusSchema>;

const statusColumns = {
  id: ['제출 번호', 'Submission #'],
  user: ['아이디', 'User'],
  problem: ['문제', '문제번호', '문제 번호', 'Problem'],
  verdict: ['결과', 'Result'],
  memory: ['메모리', 'Memory'],
  time: ['시간', 'Time'],
  language: ['언어', 'Language'],
  submitted: ['제출시간', '제출한 시간', 'Submitted'],
};

export function parseStatus(document: Document, location: string): Status[] | null {
  const url = siteUrl(location);
  if (!url || !['/status', '/status/'].includes(url.pathname) || url.searchParams.has('contest_id')) return null;
  const table = document.querySelector<HTMLTableElement>('#status-table');
  if (!table) throw new Error('BOJ_PARSING_FAILED');
  const headers = Array.from(table.tHead?.rows[0]?.cells ?? [], (cell) => cell.textContent?.trim().replace(/\s*\([^)]*\)$/, '') ?? '');
  const column = (key: keyof typeof statusColumns, fallback: number) =>
    headers.length ? headers.findIndex((header) => statusColumns[key].includes(header)) : fallback;
  const idIndex = column('id', 0);
  const userIndex = column('user', 1);
  const problemIndex = column('problem', 2);
  const verdictIndex = column('verdict', 3);
  const languageIndex = column('language', 7);
  const memoryIndex = column('memory', 4);
  const timeIndex = column('time', 5);
  const submittedIndex = column('submitted', 9);
  if ([idIndex, userIndex, problemIndex, verdictIndex, languageIndex].some((index) => index < 0)) {
    throw new Error('BOJ_PARSING_FAILED');
  }

  const number = (cell?: HTMLTableCellElement) => {
    const value = cell?.textContent?.trim() ?? '';
    return /^\d+$/.test(value) ? Number(value) : null;
  };
  const linkPath = (cell: HTMLTableCellElement | undefined, prefix: string) => {
    const link = cell?.querySelector<HTMLAnchorElement>(`a[href*="${prefix}"]`);
    const href = link?.getAttribute('href');
    const target = href?.startsWith('/') && !href.startsWith('//') ? siteUrl(url.origin + href) : href ? siteUrl(href) : undefined;
    return target?.origin === url.origin ? target.pathname : '';
  };
  return [...table.querySelectorAll<HTMLTableRowElement>('tbody > tr')].flatMap(({ cells }) => {
    const verdict = cells[verdictIndex];
    const stamp = cells[submittedIndex]?.querySelector('[data-timestamp]')?.getAttribute('data-timestamp');
    const date = stamp && /^\d{1,12}$/.test(stamp) ? new Date(Number(stamp) * 1000).toISOString() : null;
    const parsed = statusSchema.safeParse({
      submissionId: cells[idIndex]?.textContent?.trim(),
      accountContext: linkPath(cells[userIndex], '/user/').match(/^\/user\/([a-zA-Z0-9_]+)$/)?.[1]?.toLowerCase(),
      problemId: Number(linkPath(cells[problemIndex], '/problem/').match(/^\/problem\/(\d+)$/)?.[1]),
      rawVerdict: (verdict?.querySelector('.result-text') ?? verdict)?.textContent?.trim(),
      memoryKb: number(cells[memoryIndex]),
      executionTimeMs: number(cells[timeIndex]),
      language: cells[languageIndex]?.textContent?.split('/')[0]?.trim(),
      submittedAt: date,
    });
    return parsed.success ? [parsed.data] : [];
  });
}

export function submissionLanguage(label: string): Language | undefined {
  switch (label.trim().toLowerCase()) {
    case 'rust':
    case 'rust 2021': return 'rust';
    case 'c11': return 'c';
    case 'c++17': return 'cpp';
    case 'python 3': return 'python';
    case 'java 11': return 'java';
    default: return undefined;
  }
}

export const acceptedVerdict = '맞았습니다!!';

/** The Korean and English BOJ screens word an accepted result differently. */
export const isAcceptedVerdict = (raw: string) => raw === acceptedVerdict || raw === 'Accepted';

/**
 * Rows of the signed-in user's accepted submissions in a supported language, newest first.
 * With `since` (Unix ms), only rows submitted at or after it count; rows without a submission time are left out.
 */
export function acceptedRows(rows: Status[], me: string, since?: number) {
  return rows.filter((row) => row.accountContext === me && isAcceptedVerdict(row.rawVerdict)
    && submissionLanguage(row.language) !== undefined
    && (since === undefined || (row.submittedAt !== null && Date.parse(row.submittedAt) >= since)));
}

export function problemTitle(html: string) {
  return new DOMParser().parseFromString(html, 'text/html').querySelector('#problem_title')?.textContent?.trim() || null;
}
