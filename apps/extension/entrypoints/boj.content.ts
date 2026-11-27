import { defineContentScript } from 'wxt/utils/define-content-script';
import { matches, parseProblem, parseStatus } from '../adapters/boj';

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
  },
});
