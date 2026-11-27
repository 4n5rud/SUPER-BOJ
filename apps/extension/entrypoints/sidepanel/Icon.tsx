import type { ReactNode } from 'react';

const glyphs = {
  editor: <>
    <path d="M7 4H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
    <path d="m6.5 8 2 2-2 2m4.5 0h2.5" />
  </>,
  branch: <>
    <path d="M6 6.5v7m0-1.5h3a5 5 0 0 0 5-5v-.5" />
    <circle cx="6" cy="4.5" r="2" />
    <circle cx="14" cy="4.5" r="2" />
    <circle cx="6" cy="15.5" r="2" />
  </>,
  close: <path d="m5 5 10 10M15 5 5 15" />,
  settings: 'settings',
  copy: 'copy',
  tests: 'test',
  run: 'run',
  stop: 'stop',
  submit: 'open-official-page',
  debug: 'debug',
} satisfies Record<string, ReactNode>;

export function Icon({ name }: { name: keyof typeof glyphs }) {
  const glyph = glyphs[name];
  if (typeof glyph === 'string') {
    return <span className="ui-icon control-icon" data-control={glyph} aria-hidden="true" />;
  }
  return <svg className="ui-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {glyph}
  </svg>;
}
