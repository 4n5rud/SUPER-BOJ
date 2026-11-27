import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import Worker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

(self as typeof self & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new Worker(),
};

type Props = { initial: string; onChange: (text: string) => void; theme: 'dark' | 'light'; fontSize: number };

export function Editor({ initial, onChange, theme, fontSize }: Props) {
  const target = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(null);
  const initialValue = useRef(initial);
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    const instance = monaco.editor.create(target.current!, {
      value: initialValue.current, language: 'rust', automaticLayout: true,
      minimap: { enabled: false }, tabSize: 4, scrollBeyondLastLine: false,
      ariaLabel: 'Rust 소스 코드', bracketPairColorization: { enabled: true },
    });
    editor.current = instance;
    const subscription = instance.onDidChangeModelContent(() => change.current(instance.getValue()));
    return () => {
      const model = instance.getModel();
      subscription.dispose();
      instance.dispose();
      model?.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
    editor.current?.updateOptions({ fontSize });
  }, [theme, fontSize]);

  return <div className="editor" ref={target} />;
}
