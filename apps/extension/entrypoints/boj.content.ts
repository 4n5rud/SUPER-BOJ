import { defineContentScript } from 'wxt/utils/define-content-script';
import { account, acceptedRows, matches, parseProblem, parseStatus, problemTitle, siteUrl, submissionLanguage, type Status } from '../adapters/boj';

const uploadedKey = 'uploadedSubmissions';
const maxRemembered = 500;
const maxPerScan = 10;
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

async function text(path: string) {
  const response = await fetch(new URL(path, location.origin), { credentials: 'include' });
  if (!response.ok) throw new Error(`BOJ_HTTP_${response.status}`);
  return response.text();
}

async function upload(row: Status) {
  const language = submissionLanguage(row.language);
  if (!language) return;
  const source = await text(`/source/download/${row.submissionId}`);
  const title = problemTitle(await text(`/problem/${row.problemId}`));
  if (!source || !title) throw new Error('BOJ_PARSING_FAILED');
  const reply = await chrome.runtime.sendMessage({
    type: 'BOJ_ACCEPTED',
    submission: {
      accountContext: row.accountContext, submissionId: row.submissionId, problemId: row.problemId,
      problemTitle: title, source, rawVerdict: row.rawVerdict, executionTimeMs: row.executionTimeMs,
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
      if (!ready?.ok || !ready.data) return;
      const done = new Set(await remembered());
      const rows = acceptedRows(parseStatus(document, location.href) ?? [], me)
        .filter((row) => !done.has(`${row.accountContext}/${row.submissionId}`))
        .slice(0, maxPerScan);
      for (const row of rows) {
        try {
          await upload(row);
          await remember(`${row.accountContext}/${row.submissionId}`);
        } catch (error) {
          console.warn('SUPER_BOJ auto upload failed', row.submissionId, error);
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
