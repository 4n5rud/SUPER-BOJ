import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { problemSchema, statusSchema, type Problem, type Status } from '../../adapters/boj';
import { callNative } from '../../adapters/native';
import { languageSchema, type Language } from '../../adapters/protocol';
import { Editor } from './Editor';
import { Git, History, Submissions } from './Records';

const profiles = {
  rust: { label: 'Rust 2021', filename: 'main.rs', template: 'fn main() {\n    \n}\n', tool: 'rustc 1.90.0' },
  c: { label: 'C11', filename: 'Main.c', template: '#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n', tool: 'GCC 11.1.0' },
  cpp: { label: 'C++17', filename: 'Main.cc', template: '#include <iostream>\n\nint main() {\n    return 0;\n}\n', tool: 'GCC 11.1.0' },
  python: { label: 'Python 3', filename: 'Main.py', template: '', tool: 'Python 3.13.1' },
  java: { label: 'Java 11', filename: 'Main.java', template: 'public class Main {\n    public static void main(String[] args) {\n        \n    }\n}\n', tool: 'JDK 11' },
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

type Settings = z.infer<typeof settingsSchema>;
type TestCase = { input: string; expectedOutput?: string };
type Screen = 'Editor' | 'History' | 'Git' | 'Settings';

export default function App() {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [rows, setRows] = useState<Status[] | null>(null);
  const [screen, setScreen] = useState<Screen>('Editor');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [language, setLanguage] = useState<Language>('rust');
  const profile = profiles[language];
  const [probe, setProbe] = useState<{ online: boolean; tools: z.infer<typeof toolchains>['toolchains']; detail: string }>({
    online: false, tools: [], detail: '로컬 연결 확인 중',
  });
  const tool = probe.tools.find((candidate) => candidate.language === language);
  const [showSetup, setShowSetup] = useState(false);
  const [message, setMessage] = useState('');
  const [contextError, setContextError] = useState('');
  const [draft, setDraft] = useState<{ key: string; source: string }>();
  const [editorRevision, setEditorRevision] = useState(0);
  const source = useRef(profiles.rust.template);
  const writeQueue = useRef(Promise.resolve());
  const generation = useRef(0);
  const [job, setJob] = useState<string>();
  const [customIn, setCustomIn] = useState('');
  const [customOut, setCustomOut] = useState('');
  const [results, setResults] = useState<z.infer<typeof resultSchema>[]>([]);
  const draftId = problem ? JSON.stringify(['draft', problem.accountContext, problem.problemId, language]) : `scratch:${language}`;

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
      setProbe({ online: true, tools: reply.toolchains, detail: '' });
    } catch (error) {
      const missing = error instanceof Error && error.message === 'NATIVE_HOST_NOT_FOUND';
      setProbe({ online: false, tools: [], detail: missing ? '로컬 실행 도구를 설치한 뒤 다시 확인하세요.' : '로컬 실행 도구의 연결 상태를 확인하세요.' });
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
    void chrome.storage.local.get(['settings', 'language']).then(({ settings, language }) => {
      const selected = languageSchema.safeParse(language);
      if (selected.success) setLanguage(selected.data);
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
      source.current = typeof value === 'string' ? value : profile.template;
      setDraft({ key: draftId, source: source.current });
      setResults([]);
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

  async function run(cases: TestCase[]) {
    if (!cases.length || job || draft?.key !== draftId) return;
    if (!tool?.available) {
      setShowSetup(true);
      void connect();
      return;
    }
    const jobId = crypto.randomUUID();
    setJob(jobId);
    setMessage('');
    setResults([]);
    try {
      const result = await callNative('RUN_TESTS', { jobId, language, source: source.current, cases }, runSchema);
      setResults('results' in result ? result.results : [result]);
    } catch (error) { setMessage(String(error)); }
    finally { setJob(undefined); }
  }

  const custom: TestCase = { input: customIn, ...(customOut === '' ? {} : { expectedOutput: customOut }) };
  const display = draft?.key === draftId;

  return <div className="shell" data-theme={settings.theme}>
    <header><strong>SUPER_BOJ</strong>
      <button type="button" onClick={() => setScreen(screen === 'Settings' ? 'Editor' : 'Settings')}>설정</button></header>
    <div className="problem">{problem ? <><span className="muted">#{problem.problemId}</span> {problem.title}</> : '백준 문제를 열어 시작하세요'}</div>
    {contextError && <p role="alert">{contextError} <button onClick={() => void refresh()}>다시 읽기</button></p>}
    <nav aria-label="작업 화면">{([['Editor', '에디터'], ['Git', 'GitHub'], ['History', '제출 이력']] as const).map(([name, label]) =>
      <button key={name} aria-current={screen === name ? 'page' : undefined} onClick={() => { setScreen(name); setMessage(''); }}>{label}</button>)}</nav>
    {message && <p role="status" className="notice">{message}</p>}
    <main>
      {screen === 'Editor' && <>
        <div className="toolbar">
          <select aria-label="언어" value={language} disabled={!!job} onChange={(event) => {
            const value = languageSchema.parse(event.target.value);
            setLanguage(value);
            void chrome.storage.local.set({ language: value }).catch((error: unknown) => setMessage(String(error)));
          }}>{languageSchema.options.map((value) => <option key={value} value={value}>{profiles[value].label}</option>)}</select>
          <span className="mono">{profile.filename}</span>
          <button disabled={!display} onClick={() => void navigator.clipboard.writeText(source.current).then(() => setMessage('코드를 복사했습니다.')).catch((error: unknown) => setMessage(String(error)))}>코드 복사</button>
        </div>
        {display && <Editor key={`${draftId}:${editorRevision}`} language={language} initial={source.current} onChange={save} {...settings} />}
        <div className="toolbar">
          <button className="primary" disabled={!display || !!job} onClick={() => void run([...(problem?.samples ?? []), ...(customIn || customOut ? [custom] : problem?.samples.length ? [] : [custom])])}>전체 실행</button>
          <button disabled={!job} onClick={() => job && void callNative('CANCEL', { jobId: job }, z.object({ cancelled: z.boolean() })).catch((error: unknown) => setMessage(String(error)))}>중단</button>
        </div>
        <details className="tests"><summary>테스트 케이스</summary>
          {problem?.samples.map((sample) => <details key={sample.id}><summary>예제 {sample.id}</summary>
            <label>입력<pre>{sample.input}</pre></label><label>예상 출력<pre>{sample.expectedOutput}</pre></label>
            <button disabled={!display || !!job} onClick={() => void run([{ input: sample.input, expectedOutput: sample.expectedOutput }])}>이 예제 실행</button>
          </details>)}
          <label>사용자 입력<textarea value={customIn} onChange={(event) => setCustomIn(event.target.value)} /></label>
          <label>예상 출력 (선택)<textarea value={customOut} onChange={(event) => setCustomOut(event.target.value)} /></label>
          <button disabled={!display || !!job} onClick={() => void run([custom])}>사용자 테스트 실행</button>
        </details>
        {results.length > 0 && <section aria-label="실행 결과">
          {results.map((result, index) => <article className="result" key={index}>
            <strong>{index + 1}. {result.status !== 'COMPLETED' || result.passed == null ? result.status : result.passed ? 'PASSED' : 'FAILED'}</strong>
            <span className="muted"> {result.executionDurationMs == null ? '' : `${result.executionDurationMs} ms`} {result.exitCode == null ? '' : `exit ${result.exitCode}`}</span>
            {result.stdout !== undefined && <pre aria-label="실제 출력">{result.stdout || '출력 없음'}</pre>}
            {result.stderr && <pre className="notice" aria-label="오류 출력">{result.stderr}</pre>}
          </article>)}
        </section>}
        {language === 'rust' || rows
          ? <Submissions problem={problem} rows={rows} source={source} ready={display && probe.online && language === 'rust'} refresh={refresh} report={setMessage} />
          : problem && <p className="muted">이 언어는 로컬 테스트를 지원합니다. 자동 제출 이력 연결은 Rust에서 사용할 수 있습니다.</p>}
      </>}
      {screen === 'History' && <History problem={problem} report={setMessage} restore={(value) => {
        if (language !== 'rust') { setMessage('Rust 에디터를 선택한 뒤 제출 소스를 복원하세요.'); return; }
        save(value); setEditorRevision((revision) => revision + 1); setScreen('Editor'); }} />}
      {screen === 'Git' && <Git report={setMessage} online={probe.online} openSetup={() => setScreen('Settings')} />}
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
      {(screen === 'Settings' || (screen === 'Editor' && showSetup && !tool?.available)) && <section className="setup">
        <h2>로컬 실행</h2>
        <p>{tool?.version || probe.detail || `${profile.tool}과 호환되는 도구를 설치하세요.`}</p>
        <p className="muted">백준 기준 {profile.tool} · 로컬 환경에 따라 실행 결과가 달라질 수 있습니다.</p>
        {!tool?.available && <p><a href="https://github.com/4n5rud/SUPER-BOJ/blob/main/docs/INSTALLATION.md" target="_blank" rel="noreferrer">설치 방법</a></p>}
        <button onClick={() => void connect()}>연결 테스트</button>
        <details><summary>등록에 필요한 확장 ID</summary><pre>{chrome.runtime.id}</pre></details>
      </section>}
    </main>
  </div>;
}
