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

function account(document: Document, url: URL) {
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

export function parseStatus(document: Document, location: string): Status[] | null {
  const url = siteUrl(location);
  if (url?.pathname !== '/status' || url.searchParams.has('contest_id')) return null;
  const table = document.querySelector('#status-table');
  if (!table) throw new Error('BOJ_PARSING_FAILED');
  const number = (cell: HTMLTableCellElement) => {
    const value = cell.textContent?.trim() ?? '';
    return /^\d+$/.test(value) ? Number(value) : null;
  };
  return [...table.querySelectorAll<HTMLTableRowElement>('tbody > tr')].flatMap((row) => {
    const [id, user, problem, verdict, memory, time, , language, , submitted] = row.cells;
    if (!submitted) return [];
    const stamp = submitted.querySelector('[data-timestamp]')?.getAttribute('data-timestamp');
    const date = stamp && /^\d{1,12}$/.test(stamp) ? new Date(Number(stamp) * 1000).toISOString() : null;
    const parsed = statusSchema.safeParse({
      submissionId: id.textContent?.trim(),
      accountContext: user.querySelector('a[href^="/user/"]')?.getAttribute('href')?.match(/^\/user\/([a-zA-Z0-9_]+)$/)?.[1]?.toLowerCase(),
      problemId: Number(problem.querySelector('a[href^="/problem/"]')?.getAttribute('href')?.match(/^\/problem\/(\d+)$/)?.[1]),
      rawVerdict: verdict.querySelector('.result-text')?.textContent?.trim(),
      memoryKb: number(memory),
      executionTimeMs: number(time),
      language: language.textContent?.trim(),
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
