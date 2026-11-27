import { defineBackground } from 'wxt/utils/define-background';
import { z } from 'zod';
import { isAcceptedVerdict, problemSchema, siteUrl, statusSchema } from '../adapters/boj';
import { NativeClient } from '../adapters/native';
import { readGithubSession } from '../adapters/github';

import { nativeCommandSchema, payloadSchemas } from '../adapters/protocol';

const gitStatusSchema = z.object({ repository: z.object({ autoSync: z.boolean() }).nullable() });
const sinceKey = 'autoUploadSince';
const snapshotSchema = z.object({ problem: problemSchema.nullable(), rows: z.array(statusSchema).max(100).nullable() });

export default defineBackground(() => {
  const authorization = (session: Awaited<ReturnType<typeof readGithubSession>>, remoteUrl = session?.remoteUrl) =>
    session && remoteUrl ? { remoteUrl, basic: btoa(`x-access-token:${session.token}`), expiresAt: session.expiresAt } : null;
  const native = new NativeClient(async () => authorization(await readGithubSession()));
  let changingGithub = false;
  const recordAutoUploadSince = (autoSync: boolean) => autoSync
    ? chrome.storage.local.set({ [sinceKey]: Date.now() })
    : chrome.storage.local.remove(sinceKey);
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const fromBoj = sender.id === chrome.runtime.id && sender.tab !== undefined && sender.frameId === 0
      && !!sender.url && !!siteUrl(sender.url);
    if (fromBoj && (message?.type === 'BOJ_AUTO_UPLOAD_READY' || message?.type === 'BOJ_ACCEPTED')) {
      const handleBoj = async () => {
        // Accepted sources are read and imported only while automatic sync is on for a connected repository.
        const status = await native.request('GET_GIT_STATUS', {}).catch(() => null);
        const autoSync = gitStatusSchema.safeParse(status).data?.repository?.autoSync === true;
        if (message.type === 'BOJ_AUTO_UPLOAD_READY') {
          // Only submissions accepted after automatic upload was turned on are uploaded.
          if (!autoSync) {
            await chrome.storage.local.remove(sinceKey);
            return { ready: false, since: null };
          }
          const stored = (await chrome.storage.local.get(sinceKey))[sinceKey];
          if (typeof stored === 'number') return { ready: true, since: stored };
          const since = Date.now();
          await chrome.storage.local.set({ [sinceKey]: since });
          return { ready: true, since };
        }
        if (!autoSync) throw new Error('AUTO_SYNC_DISABLED');
        const submission = payloadSchemas.IMPORT_ACCEPTED_SUBMISSION.parse(message.submission);
        if (!isAcceptedVerdict(submission.rawVerdict)) throw new Error('INVALID_MESSAGE');
        return native.request('IMPORT_ACCEPTED_SUBMISSION', submission);
      };
      void handleBoj().then(
        (data) => respond({ ok: true, data }),
        (error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }),
      );
      return true;
    }
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sidepanel.html')) return;
    const handle = async () => {
      if (message?.type === 'GITHUB_CONFIGURE' || message?.type === 'GITHUB_SIGN_OUT') {
        if (changingGithub) throw new Error('GitHub 설정을 변경 중입니다.');
        changingGithub = true;
        try {
          const session = await readGithubSession();
          if (message.type === 'GITHUB_SIGN_OUT') {
            await chrome.storage.session.remove('githubSession');
            if (session?.remoteUrl) await native.request('SET_GITHUB_AUTH', { auth: null });
            return { signedOut: true };
          }
          const target = z.strictObject({
            remoteUrl: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
            branch: z.string().min(1).max(200),
            autoSync: z.boolean(),
          }).parse(message.target);
          if (!session) throw new Error('GitHub에서 다시 로그인하세요.');
          await native.request('SET_GITHUB_AUTH', { auth: authorization(session, target.remoteUrl) });
          let result: unknown;
          try {
            result = await native.request('CONFIGURE_REPOSITORY', target);
          } catch (error) {
            await native.request('SET_GITHUB_AUTH', { auth: authorization(session) }).catch(() => undefined);
            throw error;
          }
          await chrome.storage.session.set({ githubSession: { ...session, remoteUrl: target.remoteUrl } });
          await recordAutoUploadSince(target.autoSync);
          return result;
        } finally {
          changingGithub = false;
        }
      }
      if (message?.type === 'NATIVE') {
        const command = nativeCommandSchema.parse(message.command);
        const result = await native.request(command, message.payload);
        if (command === 'CONFIGURE_REPOSITORY') await recordAutoUploadSince(message.payload?.autoSync === true);
        return result;
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
