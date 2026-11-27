import { useEffect, useRef, useState } from 'react';
import { authorizeGithub, githubAppUrl, githubClientId, githubOrigins, listGithubRepositories, readGithubSession, type GithubRepository } from '../../adapters/github';

type Props = { online: boolean; onConnected: (value: unknown) => void; report: (message: string) => void };

export function GithubConnect({ online, onConnected, report }: Props) {
  const [repositories, setRepositories] = useState<GithubRepository[]>();
  const [repository, setRepository] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoSync, setAutoSync] = useState(false);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!githubClientId) return;
    const controller = new AbortController();
    void readGithubSession().then((session) => session && listGithubRepositories(session.token, controller.signal))
      .then((rows) => { if (rows && !controller.signal.aborted) setRepositories(rows); }).catch(() => undefined);
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, []);

  if (!githubClientId) return null;

  async function connect() {
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setBusy(true);
    setCode('');
    try {
      if (!await chrome.permissions.request({ origins: githubOrigins })) throw new Error('GitHub 연결 권한을 허용하세요.');
      const session = await authorizeGithub(setCode, controller.signal);
      const rows = await listGithubRepositories(session.token, controller.signal);
      await chrome.storage.session.set({ githubSession: session });
      setRepositories(rows);
      setRepository('');
      setAutoSync(false);
    } catch (error) {
      if (!controller.signal.aborted) report(error instanceof Error ? error.message : 'GitHub 연결에 실패했습니다.');
    } finally {
      if (operation.current === controller) {
        setCode('');
        setBusy(false);
      }
    }
  }

  async function choose() {
    const match = repositories?.find((row) => row.full_name === repository);
    if (!match) return;
    setBusy(true);
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'GITHUB_CONFIGURE', target: {
        remoteUrl: `https://github.com/${match.full_name}`, branch: match.default_branch, autoSync,
      } });
      if (reply?.ok !== true) throw new Error(reply?.error ?? '저장소를 연결하지 못했습니다.');
      onConnected(reply.data);
      report('GitHub 저장소를 연결했습니다.');
    } catch (error) {
      report(error instanceof Error ? error.message : 'GitHub 저장소를 연결하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'GITHUB_SIGN_OUT' });
      if (!reply?.ok) throw new Error(reply?.error ?? '로그아웃을 확인하지 못했습니다.');
      setRepositories(undefined);
      setRepository('');
    } catch (error) {
      report(error instanceof Error ? error.message : 'GitHub 연결을 해제하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="record">
    <div className="toolbar"><button className="primary" disabled={busy} onClick={() => void connect()}>
      {repositories ? 'GitHub 다시 연결' : 'GitHub 연결'}
    </button>
    {repositories && <button disabled={busy} onClick={() => void signOut()}>로그아웃</button>}
    {code && <button onClick={() => operation.current?.abort()}>취소</button>}</div>
    {code && <div>
      <p>GitHub에서 아래 코드를 입력해 연결을 승인하세요.</p>
      <pre>{code}</pre>
      <a href="https://github.com/login/device" target="_blank" rel="noreferrer">GitHub에서 승인</a>
    </div>}
    {repositories?.length === 0 && <p>쓸 수 있는 저장소가 없습니다. {githubAppUrl && <a href={githubAppUrl} target="_blank" rel="noreferrer">GitHub App에 저장소 추가</a>}</p>}
    {!!repositories?.length && <form onSubmit={(event) => { event.preventDefault(); void choose(); }}>
      <label>GitHub 저장소<select value={repository} onChange={(event) => setRepository(event.target.value)} required>
        <option value="">저장소 선택</option>
        {repositories.map((row) => <option key={row.full_name} value={row.full_name}>{row.full_name}{row.private ? ' (비공개)' : ''}</option>)}
      </select></label>
      <label className="check"><input type="checkbox" checked={autoSync} onChange={(event) => setAutoSync(event.target.checked)} /> 확인한 제출을 자동 동기화</label>
      <button disabled={busy || !repository || !online}>선택한 저장소 연결</button>
    </form>}
  </div>;
}
