import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { problemSchema, statusSchema, type Problem, type Status } from '../../adapters/boj';
import { coreInstaller, installationGuide } from '../../adapters/core-install';
import { callNative } from '../../adapters/native';
import { languageSchema, type Language } from '../../adapters/protocol';
import { Editor } from './Editor';
import { Icon } from './Icon';
import { Git, prepareSubmission, Submissions } from './Records';

const profiles = {
  rust: { label: 'Rust', submissionLabel: 'Rust 2021', template: 'fn main() {\n    \n}\n', tool: 'rustc 1.90.0' },
  c: { label: 'C', submissionLabel: 'C11', template: '#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n', tool: 'GCC 11.1.0' },
  cpp: { label: 'C++', submissionLabel: 'C++17', template: '#include <iostream>\n\nint main() {\n    return 0;\n}\n', tool: 'GCC 11.1.0' },
  python: { label: 'Python', submissionLabel: 'Python 3', template: '', tool: 'Python 3.13.1' },
  java: { label: 'Java', submissionLabel: 'Java 11', template: 'public class Main {\n    public static void main(String[] args) {\n        \n    }\n}\n', tool: 'JDK 11' },
};
const context = z.object({ problem: problemSchema.nullable(), rows: z.array(statusSchema).nullable() });
const toolchains = z.object({ toolchains: z.array(z.object({ language: z.string(), available: z.boolean(), version: z.string().optional() })) });
const resultSchema = z.object({
  status: z.string(), stdout: z.string().optional(), stderr: z.string().optional(),
  exitCode: z.number().nullable().optional(), executionDurationMs: z.number().optional(),
  compileDurationMs: z.number().optional(), passed: z.boolean().nullable().optional(),
});
const runSchema = z.union([resultSchema, z.object({ results: z.array(resultSchema) })]);
const settingsSchema = z.object({ theme: z.enum(['dark', 'light']), fontSize: z.number().int().min(10).max(28) });
const defaultSettings = { theme: 'dark', fontSize: 14 } as const;

function draftKey(problem: Problem | null, language: Language) {
  return problem ? JSON.stringify(['draft', problem.accountContext, problem.problemId, language]) : `scratch:${language}`;
}

type Settings = z.infer<typeof settingsSchema>;
type TestCase = { label: string; input: string; expectedOutput?: string };
type TestResult = z.infer<typeof resultSchema>;
type Dock = 'tests' | 'submission';
const screens = [
  { id: 'Editor', label: '에디터', icon: 'editor' },
  { id: 'Git', label: 'GitHub', icon: 'branch' },
  { id: 'Settings', label: '설정', icon: 'settings' },
] as const;
type Screen = typeof screens[number]['id'];

export default function App() {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [rows, setRows] = useState<Status[] | null>(null);
  const [screen, setScreen] = useState<Screen>('Editor');
  const workspace = useRef<HTMLElement>(null);
  const [dock, setDock] = useState<Dock | null>(null);
  const [testView, setTestView] = useState<'results' | 'cases'>('cases');
  const dockHeading = useRef<HTMLHeadingElement>(null);
  const dockOpener = useRef<HTMLButtonElement | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [language, setLanguage] = useState<Language>('rust');
  const profile = profiles[language];
  const [probe, setProbe] = useState<{ online: boolean; tools: z.infer<typeof toolchains>['toolchains']; detail: string }>({
    online: false, tools: [], detail: '로컬 연결 확인 중',
  });
  const tool = probe.tools.find((candidate) => candidate.language === language);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const connectionCheck = useRef(0);
  const connectionPending = useRef(false);
  const [installer, setInstaller] = useState<string>();
  const [message, setMessage] = useState('');
  const [preparingSubmission, setPreparingSubmission] = useState(false);
  const [contextError, setContextError] = useState('');
  const [loadedDraft, setLoadedDraft] = useState<string>();
  const source = useRef(profiles.rust.template);
  const writeQueue = useRef(Promise.resolve());
  const generation = useRef(0);
  const [job, setJob] = useState<string>();
  const [customIn, setCustomIn] = useState('');
  const [customOut, setCustomOut] = useState('');
  const [testRun, setTestRun] = useState<{ draftId: string; labels: string[]; results: TestResult[]; error?: string }>();
  const draftId = draftKey(problem, language);

  const refresh = useCallback(async () => {
    const revision = ++generation.current;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'READ_CONTEXT' });
      if (reply?.ok !== true) throw new Error(reply?.error || 'BOJ_CONTEXT_UNAVAILABLE');
      const parsed = context.parse(reply.data);
      if (revision !== generation.current) return;
      setProblem(parsed.problem);
      setRows(parsed.rows);
      setContextError('');
    } catch (error) {
      if (revision !== generation.current) return;
      setProblem(null);
      setRows(null);
      setContextError(String(error));
    }
  }, []);

  const connect = useCallback(async () => {
    if (connectionPending.current) return;
    connectionPending.current = true;
    const revision = ++connectionCheck.current;
    setCheckingConnection(true);
    try {
      await callNative('PING', {}, z.object({ status: z.literal('PONG') }));
      const reply = await callNative('GET_TOOLCHAINS', {}, toolchains);
      if (revision !== connectionCheck.current) return;
      setProbe({ online: true, tools: reply.toolchains, detail: '' });
    } catch (error) {
      if (revision !== connectionCheck.current) return;
      const missing = error instanceof Error && error.message === 'NATIVE_HOST_NOT_FOUND';
      setProbe({ online: false, tools: [], detail: missing ? '로컬 실행 도구를 설치한 뒤 다시 확인하세요.' : '로컬 실행 도구의 연결 상태를 확인하세요.' });
    } finally {
      if (revision === connectionCheck.current) {
        connectionPending.current = false;
        setCheckingConnection(false);
      }
    }
  }, []);

  useEffect(() => {
    void connect();
    void refresh();
    let active = true;
    void chrome.runtime.getPlatformInfo().then((platform) => {
      if (active) setInstaller(coreInstaller(chrome.runtime.id, platform));
    }).catch(() => undefined);
    const activation = () => void refresh();
    const update = (_id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active && (change.status === 'complete' || change.url)) void refresh();
    };
    chrome.tabs.onActivated.addListener(activation);
    chrome.tabs.onUpdated.addListener(update);
    chrome.windows.onFocusChanged.addListener(activation);
    void chrome.storage.local.get(['settings', 'language']).then(({ settings, language }) => {
      const selected = languageSchema.safeParse(language);
      if (selected.success) setLanguage(selected.data);
      const parsed = settingsSchema.safeParse(settings);
      if (parsed.success) setSettings(parsed.data);
    }).catch((error: unknown) => setMessage(String(error)));
    return () => {
      active = false;
      ++generation.current;
      ++connectionCheck.current;
      connectionPending.current = false;
      chrome.tabs.onActivated.removeListener(activation);
      chrome.tabs.onUpdated.removeListener(update);
      chrome.windows.onFocusChanged.removeListener(activation);
    };
  }, [connect, refresh]);

  useEffect(() => {
    if (probe.online) return;
    const resume = () => {
      if (!document.hidden) void connect();
    };
    const windowFocus = (windowId: number) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) resume();
    };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    chrome.windows.onFocusChanged.addListener(windowFocus);
    return () => {
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
      chrome.windows.onFocusChanged.removeListener(windowFocus);
    };
  }, [connect, probe.online]);

  useEffect(() => {
    let active = true;
    void writeQueue.current.then(() => chrome.storage.local.get(draftId)).then((entries) => {
      if (!active) return;
      const value = entries[draftId];
      source.current = typeof value === 'string' ? value : profile.template;
      setLoadedDraft(draftId);
      setTestRun(undefined);
      setCustomIn('');
      setCustomOut('');
    }).catch((error: unknown) => setMessage(String(error)));
    return () => { active = false; };
  }, [draftId, profile.template]);

  const save = (value: string) => {
    source.current = value;
    writeQueue.current = writeQueue.current.then(() => chrome.storage.local.set({ [draftId]: value }))
      .catch((error: unknown) => setMessage(String(error)));
  };

  function closeDock() {
    setDock(null);
    dockOpener.current?.focus();
  }

  function toggleDock(panel: Dock, trigger: HTMLButtonElement) {
    if (dock === panel) {
      closeDock();
      return;
    }
    dockOpener.current = trigger;
    setDock(panel);
  }

  async function run(cases: TestCase[], trigger?: HTMLButtonElement) {
    if (!cases.length || job || loadedDraft !== draftId) return;
    if (trigger) dockOpener.current = trigger;
    setDock('tests');
    setTestView('results');
    if (!tool?.available) return;
    const jobId = crypto.randomUUID();
    const labels = cases.map(({ label }) => label);
    setJob(jobId);
    setMessage('');
    setTestRun({ draftId, labels, results: [] });
    try {
      const result = await callNative('RUN_TESTS', {
        jobId, language, source: source.current,
        cases: cases.map(({ input, expectedOutput }) => ({ input, expectedOutput })),
      }, runSchema);
      const completed = 'results' in result
        ? { labels, results: result.results }
        : { labels: ['실행'], results: [result] };
      setTestRun({ draftId, ...completed });
    } catch (error) {
      setTestRun({ draftId, labels, results: [], error: String(error) });
    } finally { setJob(undefined); }
  }

  useEffect(() => {
    workspace.current?.scrollTo(0, 0);
  }, [screen]);

  useEffect(() => {
    if (screen === 'Editor' && dock) dockHeading.current?.focus({ preventScroll: true });
  }, [dock, screen]);

  const custom: TestCase = { label: '사용자 입력', input: customIn, ...(customOut === '' ? {} : { expectedOutput: customOut }) };
  const samples = (problem?.samples ?? []).map(({ id, input, expectedOutput }) => ({ label: `예제 ${id}`, input, expectedOutput }));
  const allCases = customIn || customOut || !samples.length ? [...samples, custom] : samples;
  const display = loadedDraft === draftId;
  const currentRun = testRun?.draftId === draftId ? testRun : undefined;
  const visibleDock = dock === 'submission' && rows === null ? null : dock;

  useEffect(() => {
    if (rows === null) setDock((current) => current === 'submission' ? null : current);
  }, [rows]);

  async function openOfficialSubmission() {
    if (!problem || !display || preparingSubmission) return;
    setPreparingSubmission(true);
    setMessage('');
    try {
      await prepareSubmission(problem, language, source.current, probe.online);
      setMessage(`코드를 복사했습니다. 백준에서 ${profile.submissionLabel}를 선택하고 직접 제출하세요.`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setPreparingSubmission(false);
    }
  }

  const setup = <section className="pane">
    <h2>로컬 연결</h2>
    {!probe.online ? <>
      <p>{probe.detail}</p>
      <p className="muted">로컬 테스트, 제출 기록 연결, GitHub 동기화에 로컬 연결 도구가 필요합니다.</p>
      <p className="muted">설치 후 Chrome으로 돌아오면 연결을 자동으로 확인합니다.</p>
      {installer && <p><a href={installer}>로컬 실행 도구 다운로드</a></p>}
      <details open={installer ? undefined : true}><summary>수동 설치</summary>
        <p><a href={installationGuide} target="_blank" rel="noreferrer">운영체제별 설치 방법</a></p>
        <pre>{chrome.runtime.id}</pre>
        <button onClick={() => void navigator.clipboard.writeText(chrome.runtime.id)
          .then(() => setMessage('확장 ID를 복사했습니다.')).catch((error: unknown) => setMessage(String(error)))}>
          확장 ID 복사
        </button>
      </details>
      <div className="toolbar">
        <button className="primary" disabled={checkingConnection} onClick={() => void connect()}>
          {checkingConnection ? '연결 확인 중…' : '연결 확인'}
        </button>
      </div>
    </> : <>
      <p>{profile.submissionLabel} · {tool?.version || (tool?.available ? '실행 가능' : '실행 도구 설치 필요')}</p>
      <p className="muted">백준 기준 {profile.tool} · 로컬 환경에 따라 실행 결과가 달라질 수 있습니다.</p>
      <button disabled={checkingConnection} onClick={() => void connect()}>{checkingConnection ? '연결 확인 중…' : '다시 확인'}</button>
    </>}
  </section>;

  return <div className="shell" data-theme={settings.theme}>
    <header className="app-header">
      <img className="app-mascot" src="/icons/32.png" width="24" height="24" alt="SUPER_BOJ" />
      <button className="connection" type="button" data-online={probe.online}
        onClick={() => { setScreen('Settings'); setMessage(''); }}>
        <span className="connection-dot" aria-hidden="true" />
        {checkingConnection ? '연결 확인 중' : probe.online ? '로컬 연결됨' : '로컬 미연결'}
      </button>
    </header>
    <div className="workspace">
      <nav className="workspace-nav" aria-label="작업 화면">
        {screens.map(({ id, label, icon }) => <button key={id} type="button"
          aria-current={screen === id ? 'page' : undefined}
          onClick={() => {
            if (screen === id) workspace.current?.scrollTo(0, 0);
            setScreen(id);
            setMessage('');
          }}>
          <Icon name={icon} />{label}
        </button>)}
      </nav>
      <main className="workspace-main" data-screen={screen} ref={workspace}>
        {message && <p role="status" className="notice">{message}</p>}
        {screen === 'Editor' && <div className="editor-workbench">
          {contextError && <div className="notice toolbar" role="alert">
            <span>{contextError}</span><button onClick={() => void refresh()}>다시 읽기</button>
          </div>}
          <div className="toolbar editor-toolbar">
            {problem && <div className="editor-context">
              <span className="muted mono">#{problem.problemId}</span>
              <h1 title={problem.title}>{problem.title}</h1>
            </div>}
            <select aria-label="언어" value={language} disabled={!!job} onChange={(event) => {
              const value = languageSchema.parse(event.target.value);
              setLanguage(value);
              void chrome.storage.local.set({ language: value }).catch((error: unknown) => setMessage(String(error)));
            }}>{languageSchema.options.map((value) => <option key={value} value={value}>{profiles[value].label}</option>)}</select>
            <div className="editor-actions" role="group" aria-label="에디터 작업">
              <button className="icon-button" type="button" aria-label="코드 복사" title="코드 복사" disabled={!display}
                onClick={() => void navigator.clipboard.writeText(source.current)
                  .then(() => setMessage('코드를 복사했습니다.')).catch((error: unknown) => setMessage(String(error)))}>
                <Icon name="copy" />
              </button>
              <button className="icon-button" type="button" title="테스트 패널" aria-label="테스트 패널"
                aria-expanded={dock === 'tests'} aria-controls="local-tests"
                onClick={(event) => toggleDock('tests', event.currentTarget)}>
                <Icon name="tests" />
              </button>
              <button className="icon-button primary" type="button" title="전체 실행" aria-label="전체 실행"
                disabled={!display || !!job} onClick={(event) => void run(allCases, event.currentTarget)}>
                <Icon name="run" />
              </button>
              {job && <button className="icon-button" type="button" title="실행 중지" aria-label="실행 중지"
                onClick={() => void callNative('CANCEL', { jobId: job }, z.object({ cancelled: z.boolean() }))
                  .catch((error: unknown) => setMessage(String(error)))}>
                <Icon name="stop" />
              </button>}
              {problem ? <button className="icon-button" type="button" title="공식 제출" aria-label="공식 제출"
                disabled={!display || preparingSubmission} onClick={() => void openOfficialSubmission()}>
                <Icon name="submit" />
              </button> : rows && <button className="icon-button" type="button" title="제출 기록 연결" aria-label="제출 기록 연결"
                aria-expanded={dock === 'submission'} aria-controls="submission"
                onClick={(event) => toggleDock('submission', event.currentTarget)}>
                <Icon name="submit" />
              </button>}
            </div>
          </div>
          <div className="editor-layout" data-dock-open={visibleDock !== null}>
            <div className="editor-pane">
              {display ? <Editor key={draftId} language={language} initial={source.current} onChange={save} {...settings} />
                : <p className="editor-loading" role="status">초안 불러오는 중</p>}
            </div>
            <aside className="editor-dock" hidden={visibleDock === null}
              aria-labelledby="dock-heading" onKeyDown={(event) => {
                if (event.key === 'Escape' && !event.defaultPrevented) closeDock();
              }}>
              <header className="toolbar dock-heading">
                <h2 id="dock-heading" ref={dockHeading} tabIndex={-1}>{visibleDock === 'submission' ? '제출 기록 연결' : '로컬 테스트'}</h2>
                <button className="icon-button" type="button" title="패널 닫기" aria-label="패널 닫기" onClick={closeDock}><Icon name="close" /></button>
              </header>
              <div id="local-tests" className="dock-content" hidden={dock !== 'tests'}>
                <div className="toolbar dock-views" role="group" aria-label="테스트 보기">
                  <button type="button" aria-pressed={testView === 'results'} onClick={() => setTestView('results')}>결과</button>
                  <button type="button" aria-pressed={testView === 'cases'} onClick={() => setTestView('cases')}>테스트 케이스</button>
                </div>
                {!tool?.available && <div className="toolbar">
                  <span className="muted">{checkingConnection ? '실행 도구 확인 중…' : probe.online ? '실행 도구가 필요합니다.' : '로컬 연결이 필요합니다.'}</span>
                  {!checkingConnection && (!probe.online && installer
                    ? <a href={installer}>로컬 실행 도구 다운로드</a>
                    : <button type="button" onClick={() => setScreen('Settings')}>{probe.online ? '언어 실행 도구 확인' : '설치 안내'}</button>)}
                </div>}
                {testView === 'results' ? <div className="test-results" aria-live="polite">
                  {job && <p role="status" className="muted">실행 중…</p>}
                  {!job && currentRun?.error && <p role="alert" className="notice">{currentRun.error}</p>}
                  {!job && !currentRun && tool?.available && <p className="muted">실행하면 결과가 여기에 표시됩니다.</p>}
                  {currentRun?.results.map((result, index) => <article className="result" key={index}>
                    <strong className="test-verdict" data-passed={result.status === 'COMPLETED' ? result.passed : undefined}>
                      {currentRun.labels[index] ?? `사례 ${index + 1}`} · {result.status !== 'COMPLETED' ? result.status : result.passed == null ? '완료' : result.passed ? '통과' : '실패'}
                    </strong>
                    <span className="muted"> {result.executionDurationMs == null ? '' : `${result.executionDurationMs} ms`} {result.exitCode == null ? '' : `종료 코드 ${result.exitCode}`}</span>
                    {result.stdout !== undefined && <pre aria-label="실제 출력">{result.stdout || '출력 없음'}</pre>}
                    {result.stderr && <pre className="notice" aria-label="오류 출력">{result.stderr}</pre>}
                  </article>)}
                </div> : <div className="dock-cases">
                  {samples.map((sample) => <details key={sample.label}><summary>{sample.label}</summary>
                    <div><span className="muted">입력</span><pre>{sample.input}</pre></div>
                    <div><span className="muted">예상 출력</span><pre>{sample.expectedOutput}</pre></div>
                    <button type="button" disabled={!display || !!job || !tool?.available} onClick={() => void run([sample])}>이 예제 실행</button>
                  </details>)}
                  <label>사용자 입력<textarea value={customIn} onChange={(event) => setCustomIn(event.target.value)} /></label>
                  <label>예상 출력 (선택)<textarea value={customOut} onChange={(event) => setCustomOut(event.target.value)} /></label>
                  <button type="button" disabled={!display || !!job || !tool?.available} onClick={() => void run([custom])}>사용자 테스트 실행</button>
                </div>}
              </div>
              {rows && <div id="submission" className="dock-content" hidden={visibleDock !== 'submission'}>
                <Submissions rows={rows} online={probe.online} openSetup={() => setScreen('Settings')} refresh={refresh} report={setMessage} />
              </div>}
            </aside>
          </div>
        </div>}
        {screen === 'Git' && <Git report={setMessage} online={probe.online} openSetup={() => setScreen('Settings')} />}
        {screen === 'Settings' && setup}
        {screen === 'Settings' && <section className="pane">
          <h1>편집기 설정</h1>
          <label>테마 <select value={settings.theme} onChange={(event) => {
            const value = settingsSchema.parse({ ...settings, theme: event.target.value });
            setSettings(value);
            void chrome.storage.local.set({ settings: value }).catch((error: unknown) => setMessage(String(error)));
          }}><option value="dark">다크</option><option value="light">라이트</option></select></label>
          <label>글자 크기 <input type="number" min="10" max="28" value={settings.fontSize} onChange={(event) => {
            const parsed = settingsSchema.safeParse({ ...settings, fontSize: event.target.valueAsNumber });
            if (parsed.success) {
              setSettings(parsed.data);
              void chrome.storage.local.set({ settings: parsed.data }).catch((error: unknown) => setMessage(String(error)));
            }
          }} /></label>
        </section>}
      </main>
    </div>
  </div>;
}
