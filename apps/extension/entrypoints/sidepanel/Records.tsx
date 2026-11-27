import { useEffect, useState, type RefObject } from 'react';
import { z } from 'zod';
import { type Problem, type Status } from '../../adapters/boj';
import { callNative } from '../../adapters/native';
import { githubClientId } from '../../adapters/github';
import { GithubConnect } from './GithubConnect';

type Report = (message: string) => void;
const intentSchema = z.object({ intentId: z.uuid(), sourceHash: z.string(), createdAt: z.number().int().optional() });
const attemptSchema = z.object({
  id: z.number(), accountContext: z.string(), problemId: z.number(), problemTitle: z.string(),
  submissionId: z.string(), language: z.string(), verdict: z.string(), rawVerdict: z.string().nullable(),
  executionTimeMs: z.number().nullable(), memoryKb: z.number().nullable(),
  submittedAt: z.string().nullable(), gitStatus: z.string().nullable(), commitUrl: z.string().nullable(),
});
const statusReply = z.object({
  available: z.boolean(),
  authentication: z.enum(['UNVERIFIED', 'READ_VERIFIED', 'WRITE_VERIFIED', 'FAILED']),
  repository: z.object({ remoteUrl: z.string(), branch: z.string(), autoSync: z.boolean(), webUrl: z.string() }).nullable(),
  pendingCount: z.number(), failedCount: z.number(), lastCommit: z.string().nullable(),
  lastSyncAt: z.string().nullable(), lastError: z.string().nullable(),
});

export function Submissions({ problem, rows, source, ready, refresh, report }: {
  problem: Problem | null; rows: Status[] | null; source: RefObject<string>;
  ready: boolean; refresh: () => Promise<void>; report: Report;
}) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Status>();
  const [intent, setIntent] = useState('');
  const [intents, setIntents] = useState<z.infer<typeof intentSchema>[]>([]);
  const [officialSource, setOfficialSource] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [manualId, setManualId] = useState('');
  const [manualAccount, setManualAccount] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    setPicked(undefined);
    setManual(false);
    setMismatch(false);
  }, [problem?.url]);

  useEffect(() => {
    setPicked((current) => current && !manual && !rows?.some((row) => row.submissionId === current.submissionId && row.accountContext === current.accountContext)
      ? undefined : current);
  }, [rows, manual]);

  async function prepare() {
    if (!problem || busy) return;
    const value = source.current;
    setBusy(true);
    try {
      await callNative('CREATE_SUBMISSION_INTENT', {
        intentId: crypto.randomUUID(), accountContext: problem.accountContext,
        problemId: problem.problemId, problemTitle: problem.title, source: value,
      }, intentSchema);
      await navigator.clipboard.writeText(value);
      await chrome.tabs.create({ url: new URL(`/submit/${problem.problemId}`, problem.url).href });
      report('준비한 코드를 복사했습니다. 백준 제출 화면에서 직접 제출하세요.');
    } catch (error) { report(String(error)); }
    finally { setBusy(false); }
  }

  async function choose(row: Status, isManual = false) {
    setManual(isManual);
    setPicked(row);
    setMismatch(false);
    setIntent('');
    setIntents([]);
    setConfirmed(false);
    setOfficialSource('');
    setBusy(true);
    try {
      const result = await callNative('GET_PENDING_INTENTS', { accountContext: row.accountContext, problemId: row.problemId },
        z.object({ intents: z.array(intentSchema) }));
      setIntents(result.intents);
      if (!result.intents.length) report('이 문제에 연결할 제출 준비 기록이 없습니다.');
    } catch (error) { report(String(error)); }
    finally { setBusy(false); }
  }

  async function confirm(useOfficialSnapshot = false) {
    if (!picked || !intent || !confirmed || busy) return;
    const fresh = manual && problem?.problemId === picked.problemId ? picked
      : rows?.find((row) => row.submissionId === picked.submissionId && row.accountContext === picked.accountContext && row.problemId === picked.problemId);
    if (!fresh) { report('채점 현황에서 해당 제출을 다시 선택하세요.'); return; }
    setBusy(true);
    try {
      const { language: _language, ...evidence } = fresh;
      void _language;
      let intentId = intent;
      if (useOfficialSnapshot) {
        if (!problem || problem.problemId !== fresh.problemId) throw new Error('수정된 제출 코드를 기록하려면 해당 문제 페이지에서 수동 연결을 사용하세요.');
        const created = await callNative('CREATE_SUBMISSION_INTENT', {
          intentId: crypto.randomUUID(), accountContext: fresh.accountContext, problemId: fresh.problemId,
          problemTitle: problem.title, source: officialSource,
        }, intentSchema);
        intentId = created.intentId;
      }
      const result = await callNative('CONFIRM_SUBMISSION', {
        ...evidence, intentId, source: officialSource,
      }, z.object({ submissionId: z.string(), duplicate: z.boolean() }));
      report(result.duplicate ? '이미 저장된 제출입니다.' : `제출 #${result.submissionId} 저장됨`);
      setPicked(undefined);
      setOfficialSource('');
      setMismatch(false);
    } catch (error) {
      setMismatch(String(error).includes('SUBMISSION_MISMATCH'));
      report(String(error));
    } finally { setBusy(false); }
  }

  async function update(row: Status) {
    try {
      const result = await callNative('UPDATE_VERDICT', {
        accountContext: row.accountContext, submissionId: row.submissionId, rawVerdict: row.rawVerdict,
        executionTimeMs: row.executionTimeMs, memoryKb: row.memoryKb,
      }, z.object({ updated: z.boolean() }));
      report(result.updated ? '채점 결과를 갱신했습니다.' : '채점 결과가 동일합니다.');
    } catch (error) { report(String(error)); }
  }

  return <section>
    <h2>제출 기록 연결</h2>
    <div className="toolbar">
      <button disabled={!ready || !problem || busy} onClick={() => void prepare()}>제출 준비</button>
      {problem && <a target="_blank" rel="noreferrer" href={`${new URL(problem.url).origin}/status?problem_id=${problem.problemId}`}>공식 채점 현황</a>}
      {rows && <button onClick={() => void refresh()}>현재 채점 현황 읽기</button>}
    </div>
    {problem && ready && <details>
      <summary>제출 ID로 수동 연결</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        const accountContext = problem.accountContext ?? manualAccount.trim().toLowerCase();
        void choose({ submissionId: manualId.trim(), accountContext, problemId: problem.problemId,
          language: 'Rust', rawVerdict: '', executionTimeMs: null, memoryKb: null, submittedAt: null }, true);
      }}>
        {!problem.accountContext && <label>내 백준 계정<input required pattern="[A-Za-z0-9_]{1,50}" value={manualAccount} onChange={(event) => setManualAccount(event.target.value)} /></label>}
        <label>공식 제출 ID<input required inputMode="numeric" pattern="[1-9][0-9]{0,18}" value={manualId} onChange={(event) => setManualId(event.target.value)} /></label>
        <button disabled={busy}>준비 기록 찾기</button>
      </form>
    </details>}
    {rows?.filter((row) => /^Rust(?:\s|$)/i.test(row.language)).map((row) => <div key={row.submissionId} className="record">
      <strong>#{row.submissionId}</strong> {row.accountContext} · #{row.problemId} · {row.rawVerdict}
      <div className="toolbar"><button disabled={busy} onClick={() => void choose(row)}>내 제출 연결</button>
        <button disabled={busy} onClick={() => void update(row)}>저장된 채점 결과 갱신</button></div>
    </div>)}
    {picked && <form onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
      <h3>#{picked.submissionId} 확인</h3>
      <label>제출 준비 기록<select value={intent} onChange={(event) => setIntent(event.target.value)}>
        <option value="">선택하세요</option>
        {intents.map((item) => <option key={item.intentId} value={item.intentId}>{item.createdAt === undefined ? '' : new Date(item.createdAt * 1000).toLocaleString()} · {item.sourceHash.slice(0, 20)}</option>)}
      </select></label>
      <label>공식 제출 코드<textarea rows={5} value={officialSource} onChange={(event) => { setOfficialSource(event.target.value); setMismatch(false); }} required /></label>
      <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 이 제출이 내 계정에서 이루어졌으며 공식 코드 전체를 복사했습니다.</label>
      <button className="primary" disabled={busy || !intent || !confirmed || !officialSource}>제출 확정</button>
      {mismatch && !manual && <p>실제 제출 화면에서 코드를 수정했다면 해당 문제 페이지에서 제출 ID로 수동 연결하세요.</p>}
      {mismatch && manual && <button type="button" disabled={busy || !confirmed} onClick={() => {
        if (window.confirm('공식 제출 코드의 새 스냅샷을 보존하고 이 제출 번호에 연결할까요?')) void confirm(true);
      }}>검증한 공식 코드로 새 스냅샷 생성</button>}
    </form>}
  </section>;
}

export function History({ problem, report, restore }: { problem: Problem | null; report: Report; restore: (source: string) => void }) {
  const [account, setAccount] = useState(problem?.accountContext ?? '');
  const [page, setPage] = useState<z.infer<typeof attemptSchema>[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [selected, setSelected] = useState<(z.infer<typeof attemptSchema> & { source: string })>();
  const [filter, setFilter] = useState(problem?.problemId.toString() ?? '');

  async function list(before?: number) {
    setSelected(undefined);
    try {
      const result = await callNative('GET_HISTORY', { accountContext: account.trim().toLowerCase(), ...(filter ? { problemId: Number(filter) } : {}), ...(before ? { before } : {}) },
        z.object({ attempts: z.array(attemptSchema), nextCursor: z.number().nullable() }));
      setPage(result.attempts);
      setNext(result.nextCursor);
    } catch (error) { report(String(error)); }
  }

  async function load(submissionId: string, accountContext: string) {
    try {
      setSelected(await callNative('GET_ATTEMPT', { accountContext, submissionId }, attemptSchema.extend({ source: z.string() })));
    } catch (error) { report(String(error)); }
  }

  return <section><h2>제출 이력</h2>
    <form onSubmit={(event) => { event.preventDefault(); void list(); }}>
      <label>백준 계정<input required value={account} onChange={(event) => setAccount(event.target.value)} /></label>
      <label>문제 번호 (선택)<input type="number" min="1" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <button>조회</button>
    </form>
    {page.map((item) => <article className="record" key={item.id}>
      <button onClick={() => void load(item.submissionId, item.accountContext)}>#{item.submissionId}</button>
      {' '}{item.problemTitle} · {item.language} · {item.rawVerdict ?? item.verdict}
      <p>{item.submittedAt ?? '제출 시각 미확인'} {item.executionTimeMs == null ? '' : `· ${item.executionTimeMs} ms`} {item.memoryKb == null ? '' : `· ${item.memoryKb} KB`} {item.gitStatus && `· Git ${item.gitStatus}`}</p>
      {item.commitUrl?.startsWith('https://github.com/') && <a href={item.commitUrl} target="_blank" rel="noreferrer">GitHub 커밋</a>}
    </article>)}
    {next && <button onClick={() => void list(next)}>다음 페이지</button>}
    {selected && <article><h3>#{selected.submissionId} 소스</h3><pre>{selected.source}</pre>
      <div className="toolbar"><button onClick={() => void navigator.clipboard.writeText(selected.source).catch((error: unknown) => report(String(error)))}>복사</button>
        <button disabled={problem?.problemId !== selected.problemId || problem.accountContext !== selected.accountContext}
          onClick={() => { if (window.confirm('현재 초안을 이 제출 코드로 바꿀까요?')) restore(selected.source); }}>현재 초안에 복원</button></div>
    </article>}
  </section>;
}

export function Git({ report, online, openSetup }: { report: Report; online: boolean; openSetup: () => void }) {
  const [status, setStatus] = useState<z.infer<typeof statusReply>>();
  const [remoteUrl, setRemote] = useState('');
  const [branch, setBranch] = useState('main');
  const [autoSync, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!online) return;
    let active = true;
    void callNative('GET_GIT_STATUS', {}, statusReply).then((value) => {
      if (!active) return;
      setStatus(value);
      if (value.repository) {
        setRemote(value.repository.remoteUrl);
        setBranch(value.repository.branch);
        setAuto(value.repository.autoSync);
      }
    }).catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [online, report]);

  async function action(command: string, payload: unknown) {
    setBusy(true);
    try {
      const value = await callNative(command, payload, statusReply);
      setStatus(value);
      setLoadFailed(false);
      if (command === 'CONFIGURE_REPOSITORY') setEditing(false);
    }
    catch (error) { report(String(error)); }
    finally { setBusy(false); }
  }

  return <section><h2>GitHub 동기화</h2>
    <GithubConnect online={online} report={report} onConnected={(value) => setStatus(statusReply.parse(value))} />
    {!online && <><p>GitHub 저장소에 제출을 보내려면 로컬 연결이 필요합니다.</p>
      <button onClick={openSetup}>연결 설정</button></>}
    {online && !status && (loadFailed
      ? <><p role="status">연결 상태를 확인할 수 없습니다.</p>
        <button disabled={busy} onClick={() => void action('GET_GIT_STATUS', {})}>다시 확인</button></>
      : <p role="status">연결 상태 확인 중</p>)}
    {online && !!status && (!status.repository || editing) && <details open={!githubClientId || editing}>
      <summary>저장소 주소로 연결</summary><form onSubmit={(event) => {
      event.preventDefault();
      void action('CONFIGURE_REPOSITORY', { remoteUrl, branch, autoSync });
    }}>
      <label>GitHub 저장소 URL<input value={remoteUrl} onChange={(event) => setRemote(event.target.value)} required placeholder="https://github.com/owner/repo" /></label>
      <details open={status.repository && branch !== 'main' ? true : undefined}><summary>브랜치 설정</summary>
        <label>브랜치<input value={branch} onChange={(event) => setBranch(event.target.value)} required /></label>
      </details>
      <label className="check"><input type="checkbox" checked={autoSync} onChange={(event) => setAuto(event.target.checked)} /> 확인한 제출을 이 저장소로 자동 동기화</label>
      <p className="muted">공개 저장소를 연결하면 동기화된 코드도 공개됩니다.</p>
      <button className="primary" disabled={busy}>저장소 연결</button>
      {editing && <button type="button" disabled={busy} onClick={() => setEditing(false)}>취소</button>}
    </form></details>}
    {online && status && <article className="record">
      <p>{status.available ? 'Git 감지됨' : 'Git 설치 필요'} · {
        { UNVERIFIED: '인증 확인 전', READ_VERIFIED: '읽기 확인됨', WRITE_VERIFIED: '푸시 확인됨', FAILED: '인증 실패' }[status.authentication]
      }</p>
      <p>{status.repository ? `${status.repository.branch} · 자동 동기화 ${status.repository.autoSync ? '켜짐' : '꺼짐'}` : '연결된 저장소 없음'}</p>
      {status.repository?.webUrl.startsWith('https://github.com/') && <a href={status.repository.webUrl} target="_blank" rel="noreferrer">저장소 열기</a>}
      <p>대기 {status.pendingCount}건 · 실패 {status.failedCount}건</p>
      {status.lastCommit && <pre>{status.lastCommit}</pre>}
      {status.lastSyncAt && <p>마지막 동기화 {status.lastSyncAt}</p>}
      {status.lastError && <p className="notice">{status.lastError}</p>}
      <div className="toolbar">{status.repository && !editing && <button disabled={busy} onClick={() => {
        if (!status.repository) return;
        setRemote(status.repository.remoteUrl);
        setBranch(status.repository.branch);
        setAuto(status.repository.autoSync);
        setEditing(true);
      }}>연결 변경</button>}
        <button disabled={busy} onClick={() => void action('GET_GIT_STATUS', {})}>새로고침</button>
        <button disabled={busy || !status.repository} onClick={() => {
          if (status.repository?.autoSync || window.confirm('이 저장소에 대기 중인 제출을 푸시할까요?')) {
            void action('RETRY_SYNC', { allowPush: true });
          }
        }}>동기화 재시도</button></div>
    </article>}
  </section>;
}
