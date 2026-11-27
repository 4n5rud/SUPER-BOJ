import { afterEach, expect, test, vi } from 'vitest';
import { coreInstaller } from '../adapters/core-install';

const storeId = 'abcdefghijklmnopabcdefghijklmnop';

afterEach(() => vi.unstubAllGlobals());

test('offers only a package for the configured store extension and supported platform', () => {
  vi.stubGlobal('__SUPER_BOJ_STORE_EXTENSION_ID__', storeId);
  const platforms = [
    ['mac', 'arm64', 'macos-aarch64.pkg'],
    ['mac', 'arm', 'macos-aarch64.pkg'],
    ['mac', 'x86-64', 'macos-x86_64.pkg'],
    ['win', 'x86-64', 'windows-x86_64.exe'],
    ['linux', 'x86-64', 'linux-x86_64.deb'],
  ] as const;
  for (const [os, arch, asset] of platforms) {
    expect(coreInstaller(storeId, { os, arch })).toBe(
      `https://github.com/4n5rud/SUPER-BOJ/releases/latest/download/super-boj-setup-${asset}`,
    );
  }
  expect(coreInstaller('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { os: 'mac', arch: 'arm64' })).toBeUndefined();
  expect(coreInstaller(storeId, { os: 'linux', arch: 'arm64' })).toBeUndefined();
  vi.stubGlobal('__SUPER_BOJ_STORE_EXTENSION_ID__', '');
  expect(coreInstaller(storeId, { os: 'win', arch: 'x86-64' })).toBeUndefined();
});
