const icons = {
  editor: 'editor',
  branch: 'branch',
  close: 'close',
  settings: 'settings',
  copy: 'copy',
  tests: 'test',
  run: 'run',
  stop: 'stop',
  submit: 'open-official-page',
} as const;

export function Icon({ name }: { name: keyof typeof icons }) {
  return <img className="ui-icon" src={`/icons/controls-3d/${icons[name]}.png`} width="20" height="20" alt="" />;
}
