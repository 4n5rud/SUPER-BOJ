import { z } from 'zod';
import { githubOrigins } from './github-origins';

declare const __SUPER_BOJ_GITHUB_CLIENT_ID__: string;
declare const __SUPER_BOJ_GITHUB_APP_SLUG__: string;

export const githubClientId = __SUPER_BOJ_GITHUB_CLIENT_ID__;
export const githubAppUrl = /^[a-z0-9-]+$/.test(__SUPER_BOJ_GITHUB_APP_SLUG__)
  ? `https://github.com/apps/${__SUPER_BOJ_GITHUB_APP_SLUG__}/installations/new`
  : undefined;
const reloadExtension = 'chrome://extensions에서 SUPER_BOJ를 최신 빌드(apps/extension/.output/chrome-mv3)로 다시 로드한 뒤 사이드패널을 닫았다가 다시 여세요.';

export async function requestGithubPermissions() {
  try {
    const declaredOrigins = chrome.runtime?.id && chrome.runtime.getManifest().optional_host_permissions;
    const missingOrigins = githubOrigins.filter((origin) => !declaredOrigins || !declaredOrigins.includes(origin));
    if (missingOrigins.length) {
      throw new Error(`현재 확장에 GitHub 권한 선언이 없습니다 (${missingOrigins.join(', ')}). ${reloadExtension}`);
    }

    return await chrome.permissions.request({ origins: [...githubOrigins] });
  } catch (error) {
    if (error instanceof Error && /Only permissions specified in the manifest may be requested|Extension context invalidated/i.test(error.message)) {
      throw new Error(`Chrome이 현재 확장 컨텍스트의 GitHub 권한 요청을 처리하지 못했습니다. ${reloadExtension}`);
    }
    throw error;
  }
}
export const githubSessionSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_]{20,255}$/),
  expiresAt: z.number().int().positive(),
  remoteUrl: z.string().optional(),
});
const device = z.object({
  device_code: z.string().min(1).max(256),
  user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/),
  expires_in: z.number().int().min(1).max(1800),
  interval: z.number().int().min(1).max(60),
});
const tokenReply = z.union([
  z.object({ access_token: githubSessionSchema.shape.token, expires_in: z.number().int().min(1).max(86_400).optional() }),
  z.object({ error: z.string() }),
]);
const repos = z.array(z.object({
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  default_branch: z.string().min(1).max(200),
  private: z.boolean(),
  archived: z.boolean(),
  permissions: z.object({ push: z.boolean() }).optional(),
})).max(100);
export type GithubRepository = z.infer<typeof repos>[number];

export async function readGithubSession() {
  const result = githubSessionSchema.safeParse((await chrome.storage.session.get('githubSession')).githubSession);
  return result.success && result.data.expiresAt > Math.floor(Date.now() / 1000) ? result.data : undefined;
}

async function oauth(path: 'device/code' | 'oauth/access_token', payload: Record<string, string>, signal: AbortSignal) {
  const reply = await fetch(`https://github.com/login/${path}`, {
    method: 'POST', headers: { Accept: 'application/json' }, redirect: 'error', credentials: 'omit',
    body: new URLSearchParams({ client_id: githubClientId, ...payload }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!reply.ok) throw new Error('GitHub 인증 요청에 실패했습니다.');
  return reply.json() as Promise<unknown>;
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export async function authorizeGithub(showCode: (code: string) => void, signal: AbortSignal) {
  const reply = device.parse(await oauth('device/code', {}, signal));
  showCode(reply.user_code);
  const expires = Date.now() + reply.expires_in * 1000;
  let interval = reply.interval;
  while (Date.now() + interval * 1000 < expires) {
    await wait(interval * 1000, signal);
    const result = tokenReply.parse(await oauth('oauth/access_token', {
      device_code: reply.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, signal));
    if ('access_token' in result) {
      return { token: result.access_token, expiresAt: Math.floor(Date.now() / 1000) + (result.expires_in ?? 8 * 3600) };
    }
    if (result.error === 'slow_down') interval += 5;
    else if (result.error !== 'authorization_pending') break;
  }
  throw new Error('GitHub 승인이 취소됐거나 시간이 만료됐습니다.');
}

export async function listGithubRepositories(token: string, signal: AbortSignal) {
  const result: GithubRepository[] = [];
  for (let page = 1; page <= 10; page++) {
    const url = new URL('https://api.github.com/user/repos');
    url.search = new URLSearchParams({ per_page: '100', page: String(page), sort: 'updated' }).toString();
    const reply = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
      credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (reply.status === 401) throw new Error('GitHub 로그인이 만료됐습니다. 다시 연결하세요.');
    if (!reply.ok) throw new Error('GitHub 저장소 목록을 불러오지 못했습니다.');
    const pageRepos = repos.parse(await reply.json());
    result.push(...pageRepos.filter((repo) => repo.permissions?.push && !repo.archived));
    if (pageRepos.length < 100) break;
  }
  return result;
}

const installations = z.object({
  installations: z.array(z.object({ app_slug: z.string().optional(), repository_selection: z.enum(['all', 'selected']).optional() })).max(100),
});

export type AppInstallation = { installed: boolean; selection: 'all' | 'selected' | null };

/**
 * Decides from `GET /user/installations` whether the app is installed. The call only lists installations of the app the
 * token belongs to, so an entry with another slug still counts when no entry carries this app's slug.
 */
export function appInstallation(rows: z.infer<typeof installations>['installations'], slug: string): AppInstallation {
  const own = rows.filter((row) => row.app_slug === slug);
  const found = own.length ? own : rows;
  if (!found.length) return { installed: false, selection: null };
  return { installed: true, selection: found.some((row) => row.repository_selection === 'all') ? 'all' : 'selected' };
}

export async function checkGithubInstallation(token: string, signal: AbortSignal): Promise<AppInstallation> {
  const reply = await fetch('https://api.github.com/user/installations?per_page=100', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
    credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (reply.status === 401) throw new Error('GitHub 로그인이 만료됐습니다. 다시 연결하세요.');
  if (!reply.ok) throw new Error('GitHub App 설치 상태를 확인하지 못했습니다.');
  return appInstallation(installations.parse(await reply.json()).installations, __SUPER_BOJ_GITHUB_APP_SLUG__);
}

const repositoryName = /^[A-Za-z0-9_.-]{1,100}$/;
const created = z.object({
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  default_branch: z.string().min(1).max(200),
  private: z.boolean(),
});

export function validRepositoryName(name: string) {
  return repositoryName.test(name) && name !== '.' && name !== '..' && !name.endsWith('.git');
}

/** The create call was refused (403 or 404); the repository may still be made on GitHub by hand. */
export class GithubPermissionError extends Error {}

/** Builds the text a user can send as-is: the HTTP status, GitHub's own message and the permission it asked for. */
export function permissionDeniedMessage(status: number, apiMessage: string | null, accepted: string | null) {
  const clean = (value: string | null) => value?.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '';
  const details = [clean(apiMessage), clean(accepted) && `필요 권한: ${clean(accepted)}`].filter(Boolean).join(', ');
  return `GitHub App에 저장소 생성 권한이 없습니다. (${status}${details ? `: ${details}` : ''})`;
}

/** Creates a repository under the signed-in user's account with an initial commit so the default branch exists. */
export async function createGithubRepository(token: string, name: string, isPrivate: boolean, signal: AbortSignal): Promise<GithubRepository> {
  if (!validRepositoryName(name)) throw new Error('저장소 이름은 영문, 숫자, -, _, . 로 100자 이내여야 합니다.');
  const reply = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: isPrivate, auto_init: true, description: 'SUPER_BOJ로 동기화한 백준 풀이' }),
    credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (reply.status === 401) throw new Error('GitHub 로그인이 만료됐습니다. 다시 연결하세요.');
  if (reply.status === 403 || reply.status === 404) {
    const body: unknown = await reply.json().catch(() => null);
    const apiMessage = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : null;
    throw new GithubPermissionError(permissionDeniedMessage(reply.status, apiMessage, reply.headers.get('X-Accepted-GitHub-Permissions')));
  }
  if (reply.status === 422) throw new Error('같은 이름의 저장소가 이미 있거나 쓸 수 없는 이름입니다.');
  if (!reply.ok) throw new Error('GitHub 저장소를 만들지 못했습니다.');
  const repo = created.parse(await reply.json());
  return { ...repo, archived: false, permissions: { push: true } };
}
