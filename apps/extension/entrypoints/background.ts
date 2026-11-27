import { defineBackground } from 'wxt/utils/define-background';
import { z } from 'zod';
import { problemSchema, siteUrl, statusSchema } from '../adapters/boj';
import { NativeClient } from '../adapters/native';

import { nativeCommandSchema } from '../adapters/protocol';

const snapshotSchema = z.object({ problem: problemSchema.nullable(), rows: z.array(statusSchema).max(100).nullable() });

export default defineBackground(() => {
  const native = new NativeClient();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sidepanel.html')) return;
    const handle = async () => {
      if (message?.type === 'NATIVE') {
        return native.request(nativeCommandSchema.parse(message.command), message.payload);
      }
      if (message?.type !== 'READ_CONTEXT') throw new Error('INVALID_MESSAGE');
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined || !tab.url || !siteUrl(tab.url)) return { problem: null, rows: null };
      const value = await chrome.tabs.sendMessage(tab.id, { type: 'READ_BOJ' }, { frameId: 0 });
      if (value?.error) throw new Error('BOJ_PARSING_FAILED');
      const snapshot = snapshotSchema.parse(value);
      if (snapshot.problem && new URL(snapshot.problem.url).pathname !== new URL(tab.url).pathname.replace(/\/$/, '')) {
        throw new Error('BOJ_CONTEXT_UNAVAILABLE');
      }
      return snapshot;
    };
    void handle().then(
      (data) => respond({ ok: true, data }),
      (error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }),
    );
    return true;
  });
});
