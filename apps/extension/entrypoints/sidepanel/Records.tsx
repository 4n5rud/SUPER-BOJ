import { useEffect, useState } from 'react';
import { z } from 'zod';
import { submissionLanguage, type Problem, type Status } from '../../adapters/boj';
import { type Language } from '../../adapters/protocol';
import { callNative } from '../../adapters/native';
import { githubClientId } from '../../adapters/github';
import { GithubConnect } from './GithubConnect';

type Report = (message: string) => void;
const intentSchema = z.object({ intentId: z.uuid(), sourceHash: z.string(), createdAt: z.number().int().optional() });
const statusReply = z.object({
  available: z.boolean(),
  authentication: z.enum(['UNVERIFIED', 'READ_VERIFIED', 'WRITE_VERIFIED', 'FAILED']),
  repository: z.object({ remoteUrl: z.string(), branch: z.string(), autoSync: z.boolean(), webUrl: z.string() }).nullable(),
  pendingCount: z.number(), failedCount: z.number(), lastCommit: z.string().nullable(),
  lastSyncAt: z.string().nullable(), lastError: z.string().nullable(),
});

export async function prepareSubmission(problem: Problem, language: Language, source: string, online: boolean) {
  if (online) await callNative('CREATE_SUBMISSION_INTENT', {
    intentId: crypto.randomUUID(), accountContext: problem.accountContext,
    problemId: problem.problemId, problemTitle: problem.title, source, ...(language === 'rust' ? {} : { language }),
  }, intentSchema);
  await navigator.clipboard.writeText(source);
  await chrome.tabs.create({ url: new URL(`/submit/${problem.problemId}`, problem.url).href });
}

export function Submissions({ rows, online, openSetup, refresh, report }: {
  rows: Status[]; online: boolean; openSetup: () => void; refresh: () => Promise<void>; report: Report;
}) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<{ row: Status; language: Language }>();
  const [intent, setIntent] = useState('');
  const [intents, setIntents] = useState<z.infer<typeof intentSchema>[]>([]);
  const [officialSource, setOfficialSource] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const fresh = picked && rows.find((row) => row.submissionId === picked.row.submissionId
    && row.accountContext === picked.row.accountContext && row.problemId === picked.row.problemId
    && submissionLanguage(row.language) === picked.language);

  useEffect(() => {
    if (!fresh) setPicked(undefined);
  }, [fresh]);

  async function choose(row: Status) {
    const selectedLanguage = submissionLanguage(row.language);
    if (!selectedLanguage || busy) return;
    setPicked({ row, language: selectedLanguage });
    setMismatch(false);
    setIntent('');
    setIntents([]);
    setConfirmed(false);
    setOfficialSource('');
    setBusy(true);
    try {
      const result = await callNative('GET_PENDING_INTENTS', { accountContext: row.accountContext, problemId: row.problemId, ...(selectedLanguage === 'rust' ? {} : { language: selectedLanguage }) },
        z.object({ intents: z.array(intentSchema) }));
      setIntents(result.intents);
      if (!result.intents.length) report('이 문제에 연결할 제출 준비 기록이 없습니다.');
    } catch (error) { report(String(error)); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!picked || !fresh || !intent || !confirmed || !officialSource || busy) return;
    setBusy(true);
    try {
      const { language: _language, ...evidence } = fresh;
      void _language;
      const languagePayload = picked.language === 'rust' ? {} : { language: picked.language };
      const result = await callNative('CONFIRM_SUBMISSION', {
        ...evidence, ...languagePayload, intentId: intent, source: officialSource,
      }, z.object({ submissionId: z.string(), duplicate: z.boolean() }));
      report(result.duplicate ? '이미 저장된 제출입니다.' : `제출 #${result.submissionId} 저장됨`);
      setPicked(undefined);
    } catch (error) {
      const differs = error instanceof Error && error.message.startsWith('SUBMISSION_MISMATCH');
      setMismatch(differs);
      if (!differs) report(String(error));
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

  const supportedRows = rows.filter((row) => submissionLanguage(row.language) !== undefined);

  return <section className="submission-actions" aria-label="제출 기록 연결">
    <p className="muted">채점 현황에서 연결할 제출을 선택하세요.</p>
    <div className="toolbar">
      <button onClick={() => void refresh()}>현재 채점 현황 읽기</button>
    </div>
    {!online && <div className="toolbar">
      <p className="muted">제출 기록을 연결하려면 로컬 연결을 설정하세요.</p>
      <button onClick={openSetup}>로컬 연결 설정</button>
    </div>}
    {online && !supportedRows.length && <p className="muted">이 채점 현황에 연결할 수 있는 제출이 없습니다.</p>}
    {online && supportedRows.map((row) => <div key={row.submissionId} className="record">
      <strong>#{row.submissionId}</strong> {row.accountContext} · #{row.problemId} · {row.language} · {row.rawVerdict}
      <div className="toolbar"><button disabled={busy} onClick={() => void choose(row)}>내 제출 연결</button>
        <button disabled={busy} onClick={() => void update(row)}>저장된 채점 결과 갱신</button></div>
    </div>)}
    {online && fresh && <form onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
      <h3>#{fresh.submissionId} · {fresh.language} 확인</h3>
      <label>제출 준비 기록<select value={intent} onChange={(event) => { setIntent(event.target.value); setMismatch(false); }}>
        <option value="">선택하세요</option>
        {intents.map((item) => <option key={item.intentId} value={item.intentId}>{item.createdAt === undefined ? '' : new Date(item.createdAt * 1000).toLocaleString()} · {item.sourceHash.slice(0, 20)}</option>)}
      </select></label>
      <label>공식 제출 코드<textarea rows={5} value={officialSource} onChange={(event) => { setOfficialSource(event.target.value); setConfirmed(false); setMismatch(false); }} required /></label>
      <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 이 제출이 내 계정에서 이루어졌으며 공식 코드 전체를 복사했습니다.</label>
      <button className="primary" disabled={busy || !intent || !confirmed || !officialSource}>제출 확정</button>
      {mismatch && <p role="alert">제출 정보 또는 코드가 준비 기록과 일치하지 않습니다. 선택한 기록과 복사한 공식 코드를 확인하세요.</p>}
    </form>}
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
  }, [online]);

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

  const repository = status?.repository;
  const configure = <GithubConnect online={online} report={report} onConnected={(value) => {
    setStatus(statusReply.parse(value));
    setEditing(false);
  }} />;

  return <section className="pane github-pane">
    <h1>GitHub 동기화</h1>
    {!online ? <>
      <p className="muted">동기화하려면 로컬 연결이 필요합니다.</p>
      <button onClick={openSetup}>로컬 연결 설정</button>
    </> : !status ? (loadFailed
      ? <><p role="status">연결 상태를 확인할 수 없습니다.</p>
        <button disabled={busy} onClick={() => void action('GET_GIT_STATUS', {})}>다시 확인</button></>
      : <p role="status" className="muted">연결 확인 중…</p>
    ) : !status.available ? <>
      <p role="status">저장소를 연결하려면 Git을 설치하세요.</p>
      <button onClick={() => void action('GET_GIT_STATUS', {})} disabled={busy}>다시 확인</button>
    </> : <>
      {repository ? <>
        <div className="github-repository">
          <span className="brand-icon" aria-hidden="true" />
          <div>
            {repository.webUrl.startsWith('https://github.com/')
              ? <a href={repository.webUrl} target="_blank" rel="noreferrer">{repository.webUrl.slice('https://github.com/'.length)}</a>
              : <strong>{repository.remoteUrl}</strong>}
            <p className="muted">{repository.branch} · 자동 동기화 {repository.autoSync ? '켜짐' : '꺼짐'}</p>
          </div>
        </div>
        {status.authentication === 'FAILED' && <p role="status" className="notice">GitHub 인증을 다시 확인하세요.</p>}
        {(status.pendingCount > 0 || status.failedCount > 0) && <div className="toolbar">
          <p className="muted">대기 {status.pendingCount}건 · 실패 {status.failedCount}건</p>
          <button disabled={busy} onClick={() => {
            if (repository.autoSync || window.confirm('이 저장소에 대기 중인 제출을 푸시할까요?')) {
              void action('RETRY_SYNC', { allowPush: true });
            }
          }}>동기화 재시도</button>
        </div>}
        <details>
          <summary>연결 관리</summary>
          {configure}
          <div className="toolbar">
            <button disabled={busy} onClick={() => {
              setRemote(repository.remoteUrl);
              setBranch(repository.branch);
              setAuto(repository.autoSync);
              setEditing(true);
            }}>저장소 설정 변경</button>
            <button disabled={busy} onClick={() => void action('GET_GIT_STATUS', {})}>상태 갱신</button>
          </div>
          {status.lastSyncAt && <p>마지막 동기화 {status.lastSyncAt}</p>}
          {status.lastCommit && <pre>{status.lastCommit}</pre>}
          {status.lastError && <p className="notice">{status.lastError}</p>}
        </details>
      </> : configure}
      {(!repository || editing) && <details open={!githubClientId || editing ? true : undefined}>
        <summary>{editing ? '저장소 설정' : '저장소 주소로 연결'}</summary>
        <form onSubmit={(event) => {
          event.preventDefault();
          void action('CONFIGURE_REPOSITORY', { remoteUrl, branch, autoSync });
        }}>
          <label>GitHub 저장소 URL<input value={remoteUrl} onChange={(event) => setRemote(event.target.value)}
            required placeholder="https://github.com/owner/repo" /></label>
          <details open={repository && branch !== 'main' ? true : undefined}><summary>브랜치 설정</summary>
            <label>브랜치<input value={branch} onChange={(event) => setBranch(event.target.value)} required /></label>
          </details>
          <label className="check"><input type="checkbox" checked={autoSync} onChange={(event) => setAuto(event.target.checked)} /> 맞은 제출을 자동으로 GitHub에 올리기</label>
          <p className="muted">공개 저장소에 동기화한 코드는 공개됩니다.</p>
          <div className="toolbar">
            <button className="primary" disabled={busy}>{editing ? '저장' : '저장소 연결'}</button>
            {editing && <button type="button" disabled={busy} onClick={() => setEditing(false)}>취소</button>}
          </div>
        </form>
      </details>}
    </>}
  </section>;
}
