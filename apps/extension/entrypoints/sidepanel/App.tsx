import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { problemSchema, statusSchema, type Problem, type Status } from '../../adapters/boj';
import { callNative } from '../../adapters/native';
import { Editor } from './Editor';
import { Git, History, Submissions } from './Records';

const template = 'fn main() {\n    \n}\n';
const context = z.object({ problem: problemSchema.nullable(), rows: z.array(statusSchema).nullable() });
const toolchains = z.object({ toolchains: z.array(z.object({ available: z.boolean(), version: z.string().optional() })) });
const resultSchema = z.object({
  status: z.string(), stdout: z.string().optional(), stderr: z.string().optional(),
  exitCode: z.number().nullable().optional(), executionDurationMs: z.number().optional(),
  compileDurationMs: z.number().optional(), passed: z.boolean().nullable().optional(),
});
const runSchema = z.union([resultSchema, z.object({ results: z.array(resultSchema) })]);
const settingsSchema = z.object({ theme: z.enum(['dark', 'light']), fontSize: z.number().int().min(10).max(28) });
const defaultSettings = { theme: 'dark', fontSize: 14 } as const;

type Settings = z.infer<typeof settingsSchema>;
type TestCase = { input: string; expectedOutput?: string };
type Screen = 'Editor' | 'History' | 'Git' | 'Settings';

export default function App() {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [rows, setRows] = useState<Status[] | null>(null);
  const [screen, setScreen] = useState<Screen>('Editor');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [probe, setProbe] = useState({ online: false, version: '', detail: 'Native Core 확인 중' });
  const [message, setMessage] = useState('');
  const [contextError, setContextError] = useState('');
  const [draft, setDraft] = useState<{ key: string; source: string }>();
  const [editorRevision, setEditorRevision] = useState(0);
  const source = useRef(template);
  const writeQueue = useRef(Promise.resolve());
  const generation = useRef(0);
  const [job, setJob] = useState<string>();
  const [customIn, setCustomIn] = useState('');
  const [customOut, setCustomOut] = useState('');
  const [results, setResults] = useState<z.infer<typeof resultSchema>[]>([]);
  const draftId = problem ? JSON.stringify(['draft', problem.accountContext, problem.problemId, 'rust']) : 'scratch:rust';

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
    try {
      await callNative('PING', {}, z.object({ status: z.literal('PONG') }));
      const reply = await callNative('GET_TOOLCHAINS', {}, toolchains);
      setProbe({ online: true, version: reply.toolchains[0]?.version ?? '', detail: reply.toolchains[0]?.available ? '' : 'rustc 설치 또는 경로 확인 필요' });
    } catch (error) {
      setProbe({ online: false, version: '', detail: String(error) });
    }
  }, []);

  useEffect(() => {
    void connect();
    void refresh();
    const activation = () => void refresh();
    const update = (_id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active && (change.status === 'complete' || change.url)) void refresh();
    };
    chrome.tabs.onActivated.addListener(activation);
    chrome.tabs.onUpdated.addListener(update);
    chrome.windows.onFocusChanged.addListener(activation);
    void chrome.storage.local.get('settings').then(({ settings }) => {
      const parsed = settingsSchema.safeParse(settings);
      if (parsed.success) setSettings(parsed.data);
    }).catch((error: unknown) => setMessage(String(error)));
    return () => {
      ++generation.current;
      chrome.tabs.onActivated.removeListener(activation);
      chrome.tabs.onUpdated.removeListener(update);
      chrome.windows.onFocusChanged.removeListener(activation);
    };
  }, [connect, refresh]);

  useEffect(() => {
    let active = true;
    void writeQueue.current.then(() => chrome.storage.local.get(draftId)).then((entries) => {
      if (!active) return;
      const value = entries[draftId];
      source.current = typeof value === 'string' ? value : template;
      setDraft({ key: draftId, source: source.current });
      setResults([]);
      setCustomIn('');
      setCustomOut('');
    }).catch((error: unknown) => setMessage(String(error)));
    return () => { active = false; };
  }, [draftId]);

  const save = (value: string) => {
    source.current = value;
    writeQueue.current = writeQueue.current.then(() => chrome.storage.local.set({ [draftId]: value }))
      .catch((error: unknown) => setMessage(String(error)));
  };

  async function run(cases: TestCase[]) {
    if (!cases.length || !probe.version || job || draft?.key !== draftId) return;
    const jobId = crypto.randomUUID();
    setJob(jobId);
    setMessage('');
    setResults([]);
    try {
      const result = await callNative('RUN_TESTS', { jobId, language: 'rust', source: source.current, cases }, runSchema);
      setResults('results' in result ? result.results : [result]);
    } catch (error) { setMessage(String(error)); }
    finally { setJob(undefined); }
  }

  const custom: TestCase = { input: customIn, ...(customOut === '' ? {} : { expectedOutput: customOut }) };
  const display = draft?.key === draftId;

  return <div className="shell" data-theme={settings.theme}>
    <header><div><strong>SUPER_BOJ</strong><span className="slogan">Every attempt is a commit.</span></div>
      <span className={probe.online ? 'connected' : 'muted'}>{probe.online ? '● 연결됨' : '○ 연결 확인'}</span></header>
    <div className="problem">{problem ? <><span className="muted">#{problem.problemId}</span> {problem.title}</> : '백준 문제를 열어 시작하세요'}</div>
    {contextError && <p role="alert">{contextError} <button onClick={() => void refresh()}>다시 읽기</button></p>}
    <nav aria-label="작업 화면">{(['Editor', 'History', 'Git', 'Settings'] as const).map((name) =>
      <button key={name} aria-current={screen === name ? 'page' : undefined} onClick={() => { setScreen(name); setMessage(''); }}>{name}</button>)}</nav>
    {message && <p role="status" className="notice">{message}</p>}
    <main>
      {screen === 'Editor' && <>
        <div className="toolbar"><label>언어 <select defaultValue="rust"><option value="rust">Rust</option></select></label>
          <span className="mono">main.rs</span>
          <button disabled={!display} onClick={() => void navigator.clipboard.writeText(source.current).then(() => setMessage('코드를 복사했습니다.')).catch((error: unknown) => setMessage(String(error)))}>코드 복사</button>
        </div>
        {display && <Editor key={`${draftId}:${editorRevision}`} initial={source.current} onChange={save} {...settings} />}
        <div className="toolbar">
          <button className="primary" disabled={!probe.version || !display || !!job} onClick={() => void run([...(problem?.samples ?? []), ...(customIn || customOut ? [custom] : problem?.samples.length ? [] : [custom])])}>전체 실행</button>
          <button disabled={!job} onClick={() => job && void callNative('CANCEL', { jobId: job }, z.object({ cancelled: z.boolean() })).catch((error: unknown) => setMessage(String(error)))}>중단</button>
        </div>
        <section className="tests"><h2>테스트 케이스</h2>
          {problem?.samples.map((sample) => <details key={sample.id}><summary>예제 {sample.id}</summary>
            <label>입력<pre>{sample.input}</pre></label><label>예상 출력<pre>{sample.expectedOutput}</pre></label>
            <button disabled={!probe.version || !!job} onClick={() => void run([{ input: sample.input, expectedOutput: sample.expectedOutput }])}>이 예제 실행</button>
          </details>)}
          <label>사용자 입력<textarea value={customIn} onChange={(event) => setCustomIn(event.target.value)} /></label>
          <label>예상 출력 (선택)<textarea value={customOut} onChange={(event) => setCustomOut(event.target.value)} /></label>
          <button disabled={!probe.version || !!job} onClick={() => void run([custom])}>사용자 테스트 실행</button>
          {results.map((result, index) => <article className="result" key={index}>
            <strong>{index + 1}. {result.status !== 'COMPLETED' || result.passed == null ? result.status : result.passed ? 'PASSED' : 'FAILED'}</strong>
            <span className="muted"> {result.executionDurationMs == null ? '' : `${result.executionDurationMs} ms`} {result.exitCode == null ? '' : `exit ${result.exitCode}`}</span>
            {result.stdout !== undefined && <pre aria-label="실제 출력">{result.stdout || '출력 없음'}</pre>}
            {result.stderr && <pre className="notice" aria-label="오류 출력">{result.stderr}</pre>}
          </article>)}
        </section>
        <Submissions problem={problem} rows={rows} source={source} ready={display && probe.online} refresh={refresh} report={setMessage} />
      </>}
      {screen === 'History' && <History problem={problem} report={setMessage} restore={(value) => { save(value); setEditorRevision((revision) => revision + 1); setScreen('Editor'); }} />}
      {screen === 'Git' && <Git report={setMessage} />}
      {screen === 'Settings' && <section>
        <h2>편집기 설정</h2>
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
      {(!probe.online || !probe.version || screen === 'Settings') && <section className="setup">
        <h2>Native Core 설치 및 연결</h2>
        <ol><li>Native Core를 빌드하거나 운영체제용 바이너리를 받습니다.</li><li>Chrome 확장 프로그램 페이지에서 아래 ID로 Native Host를 등록합니다.</li><li>Rust 툴체인을 설치하고 연결을 다시 확인합니다.</li></ol>
        <pre>{chrome.runtime.id}</pre>
        <button onClick={() => void connect()}>연결 테스트</button>
        <p>{probe.detail || probe.version}</p>
      </section>}
    </main>
    <footer>{probe.version || 'rustc 연결 대기'} <span>로컬 실행 환경은 백준과 다를 수 있습니다.</span></footer>
  </div>;
}
