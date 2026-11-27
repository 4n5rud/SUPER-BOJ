import { useEffect, useRef, useState } from 'react';
import { authorizeGithub, checkGithubInstallation, createGithubRepository, githubAppUrl, GithubPermissionError, githubClientId, listGithubRepositories, readGithubSession, requestGithubPermissions, validRepositoryName, type AppInstallation, type GithubRepository } from '../../adapters/github';

type Props = { online: boolean; onConnected: (value: unknown) => void; report: (message: string) => void };

export function GithubConnect({ online, onConnected, report }: Props) {
  const [repositories, setRepositories] = useState<GithubRepository[]>();
  const [repository, setRepository] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [accessHint, setAccessHint] = useState(false);
  const [installation, setInstallation] = useState<AppInstallation>();
  const [createDenied, setCreateDenied] = useState(false);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [newName, setNewName] = useState('boj-solutions');
  const [newPrivate, setNewPrivate] = useState(false);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!githubClientId) return;
    const controller = new AbortController();
    void readGithubSession().then(async (session) => {
      if (!session) return;
      // A failed install check must not block the repository list.
      const installed = await checkGithubInstallation(session.token, controller.signal).catch(() => undefined);
      if (!controller.signal.aborted) setInstallation(installed);
      const rows = await listGithubRepositories(session.token, controller.signal);
      if (!controller.signal.aborted) setRepositories(rows);
    }).catch(() => undefined);
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
      if (!await requestGithubPermissions()) throw new Error('GitHub 연결 권한을 허용하세요.');
      const session = await authorizeGithub(setCode, controller.signal);
      const installed = await checkGithubInstallation(session.token, controller.signal).catch(() => undefined);
      const rows = await listGithubRepositories(session.token, controller.signal);
      await chrome.storage.session.set({ githubSession: session });
      setInstallation(installed);
      setRepositories(rows);
      setRepository('');
      setAutoSync(true);
      setAccessHint(false);
      setMode(rows.length ? 'existing' : 'new');
    } catch (error) {
      if (!controller.signal.aborted) report(error instanceof Error ? error.message : 'GitHub 연결에 실패했습니다.');
    } finally {
      if (operation.current === controller) {
        setCode('');
        setBusy(false);
      }
    }
  }

  async function configure(match: GithubRepository, attempts = 1) {
    for (let attempt = 1; ; attempt++) {
      const reply = await chrome.runtime.sendMessage({ type: 'GITHUB_CONFIGURE', target: {
        remoteUrl: `https://github.com/${match.full_name}`, branch: match.default_branch, autoSync,
      } });
      if (reply?.ok === true) return reply.data as unknown;
      // A freshly created repository can take a moment before its first commit is fetchable.
      if (attempt >= attempts) throw new Error(reply?.error ?? '저장소를 연결하지 못했습니다.');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async function choose() {
    const match = repositories?.find((row) => row.full_name === repository);
    if (!match) return;
    setBusy(true);
    try {
      onConnected(await configure(match));
      report('GitHub 저장소를 연결했습니다.');
    } catch (error) {
      report(error instanceof Error ? error.message : 'GitHub 저장소를 연결하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!validRepositoryName(name) || busy) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setBusy(true);
    try {
      const session = await readGithubSession();
      if (!session) throw new Error('GitHub에서 다시 로그인하세요.');
      setCreateDenied(false);
      const made = await createGithubRepository(session.token, name, newPrivate, controller.signal);
      setAccessHint(false);
      setRepositories((rows) => [made, ...(rows ?? [])]);
      setRepository(made.full_name);
      try {
        onConnected(await configure(made, 3));
        report(`새 저장소 ${made.full_name}을 만들고 연결했습니다.`);
      } catch (error) {
        // The repository exists but the GitHub App cannot reach it yet; let the user retry from the existing list.
        setMode('existing');
        setAccessHint(true);
        report(`새 저장소 ${made.full_name}을 만들었지만 연결하지 못했습니다. ${error instanceof Error ? error.message : ''}`.trim());
      }
    } catch (error) {
      if (error instanceof GithubPermissionError) setCreateDenied(true);
      if (!controller.signal.aborted) report(error instanceof Error ? error.message : 'GitHub 저장소를 만들지 못했습니다.');
    } finally {
      if (operation.current === controller) setBusy(false);
    }
  }

  async function recheckInstallation() {
    setBusy(true);
    try {
      const session = await readGithubSession();
      if (!session) throw new Error('GitHub에서 다시 로그인하세요.');
      const signal = new AbortController().signal;
      const installed = await checkGithubInstallation(session.token, signal);
      setInstallation(installed);
      if (!installed.installed) {
        report('아직 설치가 확인되지 않습니다. GitHub에서 설치를 마친 뒤 다시 확인하세요.');
      } else {
        setRepositories(await listGithubRepositories(session.token, signal));
        report('SUPER-BOJ 앱 설치를 확인했습니다.');
      }
    } catch (error) {
      report(error instanceof Error ? error.message : 'GitHub App 설치 상태를 확인하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshRepositories() {
    setBusy(true);
    try {
      const session = await readGithubSession();
      if (!session) throw new Error('GitHub에서 다시 로그인하세요.');
      const rows = await listGithubRepositories(session.token, new AbortController().signal);
      setRepositories(rows);
      const name = newName.trim().toLowerCase();
      const found = rows.find((row) => row.full_name.split('/')[1]?.toLowerCase() === name);
      if (found) {
        setRepository(found.full_name);
        setMode('existing');
        setCreateDenied(false);
        report(`${found.full_name}을 찾았습니다. 저장소 연결을 누르세요.`);
      } else {
        report('목록에 아직 없습니다. 만든 뒤 앱 접근을 허용했는지 확인하세요.');
      }
    } catch (error) {
      report(error instanceof Error ? error.message : '저장소 목록을 불러오지 못했습니다.');
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

  return <div className="github-connect">
    <div className="toolbar"><button className="primary github-login" disabled={!online || busy} onClick={() => void connect()}>
      <span className="brand-icon" aria-hidden="true" />
      {repositories ? 'GitHub 다시 연결' : 'GitHub로 연결'}
    </button>
    {repositories && <button disabled={busy} onClick={() => void signOut()}>로그아웃</button>}
    {code && <button onClick={() => operation.current?.abort()}>취소</button>}</div>
    {code && <div>
      <p>GitHub에서 아래 코드를 입력해 연결을 승인하세요.</p>
      <pre>{code}</pre>
      <a href="https://github.com/login/device" target="_blank" rel="noreferrer">GitHub에서 승인</a>
    </div>}
    {repositories && installation?.installed === false && <div role="alert">
      <p>SUPER-BOJ 앱을 GitHub 계정에 설치하세요. 설치하지 않으면 저장소를 만들거나 연결할 수 없습니다.</p>
      {githubAppUrl && <p><a href={githubAppUrl} target="_blank" rel="noreferrer">GitHub에서 앱 설치</a> (설치할 때 All repositories 선택을 권장합니다)</p>}
      <button type="button" disabled={busy || !online} onClick={() => void recheckInstallation()}>설치했어요, 다시 확인</button>
    </div>}
    {repositories && installation?.installed !== false && <div className="segmented" role="radiogroup" aria-label="저장소 고르는 방법">
      <button type="button" role="radio" aria-checked={mode === 'existing'} onClick={() => setMode('existing')}>기존 저장소</button>
      <button type="button" role="radio" aria-checked={mode === 'new'} onClick={() => setMode('new')}>새 저장소 만들기</button>
    </div>}
    {mode === 'new' && installation?.selection === 'selected' && <p className="muted">앱이 선택한 저장소에만 설치돼 있어, 새로 만든 저장소는 앱 접근에 추가해야 할 수 있습니다.{githubAppUrl && <> <a href={githubAppUrl} target="_blank" rel="noreferrer">앱 접근 설정 열기</a></>}</p>}
    {accessHint && <p role="alert">GitHub App 설치 설정에서 새 저장소 접근을 허용한 뒤 저장소 연결을 누르세요.{githubAppUrl && <> <a href={githubAppUrl} target="_blank" rel="noreferrer">GitHub App 설치 설정 열기</a></>}</p>}
    {repositories && installation?.installed !== false && mode === 'existing' && (repositories.length === 0
      ? <p>쓸 수 있는 저장소가 없습니다. 새 저장소를 만들거나 {githubAppUrl && <a href={githubAppUrl} target="_blank" rel="noreferrer">GitHub App에 저장소를 추가</a>}하세요.</p>
      : <form onSubmit={(event) => { event.preventDefault(); void choose(); }}>
        <label>GitHub 저장소<select value={repository} onChange={(event) => setRepository(event.target.value)} required>
          <option value="">저장소 선택</option>
          {repositories.map((row) => <option key={row.full_name} value={row.full_name}>{row.full_name}{row.private ? ' (비공개)' : ''}</option>)}
        </select></label>
        <label className="check"><input type="checkbox" checked={autoSync} onChange={(event) => setAutoSync(event.target.checked)} /> 맞은 제출의 코드를 백준에서 읽어 GitHub에 자동으로 올리기</label>
        <button disabled={busy || !repository || !online}>저장소 연결</button>
      </form>)}
    {repositories && installation?.installed !== false && mode === 'new' && <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label>새 저장소 이름<input value={newName} onChange={(event) => setNewName(event.target.value)} required maxLength={100}
        pattern="[A-Za-z0-9_.\-]+" aria-invalid={!validRepositoryName(newName.trim())} /></label>
      <label className="check"><input type="checkbox" checked={newPrivate} onChange={(event) => setNewPrivate(event.target.checked)} /> 비공개 저장소로 만들기</label>
      <label className="check"><input type="checkbox" checked={autoSync} onChange={(event) => setAutoSync(event.target.checked)} /> 맞은 제출의 코드를 백준에서 읽어 GitHub에 자동으로 올리기</label>
      {!newPrivate && <p className="muted">공개 저장소에 올린 코드는 누구나 볼 수 있습니다.</p>}
      <button className="primary" disabled={busy || !online || !validRepositoryName(newName.trim())}>만들고 연결</button>
      {createDenied && <ol role="alert">
        <li><a href={`https://github.com/new?name=${encodeURIComponent(newName.trim())}&visibility=${newPrivate ? 'private' : 'public'}`} target="_blank" rel="noreferrer">GitHub에서 직접 만들기</a>
          {' '}(저장소 이름: <strong>{newName.trim()}</strong>, {newPrivate ? '비공개' : '공개'})</li>
        {githubAppUrl && <li><a href={githubAppUrl} target="_blank" rel="noreferrer">GitHub App 접근 허용</a> (앱을 &quot;선택한 저장소만&quot;으로 설치했다면 만든 저장소를 추가하세요)</li>}
        <li><button type="button" disabled={busy || !online} onClick={() => void refreshRepositories()}>목록 새로고침</button></li>
      </ol>}
    </form>}
  </div>;
}
