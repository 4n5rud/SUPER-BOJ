declare module '*?worker' {
  const Worker: { new (): globalThis.Worker };
  export default Worker;
}

declare module 'monaco-editor/esm/vs/editor/editor.api.js' {
  export * from 'monaco-editor';
}
