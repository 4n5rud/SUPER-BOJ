import { defineContentScript } from 'wxt/utils/define-content-script';
import { account, acceptedRows, acceptedVerdict, matches, parseProblem, parseStatus, problemTitle, siteUrl, submissionLanguage, type Status } from '../adapters/boj';

const uploadedKey = 'uploadedSubmissions';
const maxRemembered = 500;
const maxPerScan = 10;
const maxAttempts = 3;
const requestGapMs = 1000;
const failedKey = 'failedSubmissions';
const watchMs = 10 * 60 * 1000;

async function remembered(): Promise<string[]> {
  try {
    const value = (await chrome.storage.local.get(uploadedKey))[uploadedKey];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

async function remember(key: string) {
  const list = (await remembered()).filter((item) => item !== key);
  list.unshift(key);
  await chrome.storage.local.set({ [uploadedKey]: list.slice(0, maxRemembered) }).catch(() => undefined);
}

type Failures = Record<string, { attempts: number; permanent: boolean }>;

async function failures(): Promise<Failures> {
  try {
    const value = (await chrome.storage.local.get(failedKey))[failedKey];
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Failures : {};
  } catch { return {}; }
}

/** Permanent failures are never retried; the others stop after maxAttempts. */
async function fail(key: string, permanent: boolean) {
  const all = await failures();
  const { [key]: previous, ...rest } = all;
  const next = { ...rest, [key]: { attempts: (previous?.attempts ?? 0) + 1, permanent: permanent || previous?.permanent === true } };
  const kept = Object.fromEntries(Object.entries(next).slice(-maxRemembered));
  await chrome.storage.local.set({ [failedKey]: kept }).catch(() => undefined);
}

const permanentErrors = ['BOJ_SOURCE_NOT_CODE', 'BOJ_PARSING_FAILED', 'SUBMISSION_MISMATCH', 'INVALID_MESSAGE'];
const isPermanent = (error: unknown) => error instanceof Error && permanentErrors.some((code) => error.message.startsWith(code));

let lastRequestAt = 0;
async function pace() {
  const wait = lastRequestAt + requestGapMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function text(path: string, expectCode: boolean) {
  await pace();
  // A login or block page must never be stored as source code, so source downloads do not follow redirects.
  const response = await fetch(new URL(path, location.origin), { credentials: 'include', ...(expectCode ? { redirect: 'manual' as const } : {}) });
  if (expectCode && (response.type === 'opaqueredirect' || response.redirected || (response.status >= 300 && response.status < 400))) {
    throw new Error('BOJ_SOURCE_NOT_CODE');
  }
  if (!response.ok) throw new Error(`BOJ_HTTP_${response.status}`);
  const body = await response.text();
  if (expectCode && (/text\/html/i.test(response.headers.get('content-type') ?? '') || /^\s*<(!doctype|html)/i.test(body))) {
    throw new Error('BOJ_SOURCE_NOT_CODE');
  }
  return body;
}

async function upload(row: Status) {
  const language = submissionLanguage(row.language);
  if (!language) return;
  const source = await text(`/source/download/${row.submissionId}`, true);
  const title = problemTitle(await text(`/problem/${row.problemId}`, false));
  if (!source || !title) throw new Error('BOJ_PARSING_FAILED');
  const reply = await chrome.runtime.sendMessage({
    type: 'BOJ_ACCEPTED',
    submission: {
      accountContext: row.accountContext, submissionId: row.submissionId, problemId: row.problemId,
      problemTitle: title, source, rawVerdict: acceptedVerdict, executionTimeMs: row.executionTimeMs,
      memoryKb: row.memoryKb, submittedAt: row.submittedAt, ...(language === 'rust' ? {} : { language }),
    },
  });
  if (!reply?.ok) throw new Error(reply?.error ?? 'INTERNAL_ERROR');
}

function watchAcceptedSubmissions() {
  const url = siteUrl(location.href);
  const me = url && account(document, url);
  const table = document.querySelector('#status-table');
  if (!me || !table) return;
  let running = false;
  let again = false;
  const scan = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      const ready = await chrome.runtime.sendMessage({ type: 'BOJ_AUTO_UPLOAD_READY' });
      const since = ready?.ok && ready.data?.ready === true ? ready.data.since : undefined;
      if (typeof since !== 'number') return;
      const done = new Set(await remembered());
      const failed = await failures();
      const rows = acceptedRows(parseStatus(document, location.href) ?? [], me, since)
        .filter((row) => {
          const key = `${row.accountContext}/${row.submissionId}`;
          const failure = failed[key];
          return !done.has(key) && !(failure && (failure.permanent || failure.attempts >= maxAttempts));
        })
        .slice(0, maxPerScan);
      for (const row of rows) {
        const key = `${row.accountContext}/${row.submissionId}`;
        try {
          await upload(row);
          await remember(key);
        } catch (error) {
          console.warn('SUPER_BOJ auto upload failed', row.submissionId, error);
          // Turning the setting off mid-scan is not the submission's fault.
          if (error instanceof Error && error.message.startsWith('AUTO_SYNC_DISABLED')) break;
          await fail(key, isPermanent(error));
        }
      }
    } catch (error) {
      console.warn('SUPER_BOJ auto upload unavailable', error);
    } finally {
      running = false;
      if (again) { again = false; void scan(); }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void scan(), 1000);
  });
  observer.observe(table, { subtree: true, childList: true, characterData: true });
  setTimeout(() => observer.disconnect(), watchMs);
  void scan();
}

export default defineContentScript({
  matches: [...matches],
  main() {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js') || message?.type !== 'READ_BOJ') return;
      try {
        respond({ problem: parseProblem(document, location.href), rows: parseStatus(document, location.href) });
      } catch {
        respond({ error: 'BOJ_PARSING_FAILED' });
      }
    });
    try {
      if (parseStatus(document, location.href)) watchAcceptedSubmissions();
    } catch {
      // The status table could not be read; the side panel reports parsing errors.
    }
  },
});
