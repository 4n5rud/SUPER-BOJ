declare const __SUPER_BOJ_STORE_EXTENSION_ID__: string;

export const installationGuide = 'https://github.com/4n5rud/SUPER-BOJ/blob/main/docs/INSTALLATION.md';

export function coreInstaller(extensionId: string, platform: chrome.runtime.PlatformInfo) {
  if (!/^[a-p]{32}$/.test(extensionId) || extensionId !== __SUPER_BOJ_STORE_EXTENSION_ID__) return undefined;
  const { os, arch } = platform;
  const asset = os === 'mac' && (arch === 'arm' || arch === 'arm64') ? 'macos-aarch64.pkg'
    : os === 'mac' && arch === 'x86-64' ? 'macos-x86_64.pkg'
      : os === 'win' && arch === 'x86-64' ? 'windows-x86_64.exe'
        : os === 'linux' && arch === 'x86-64' ? 'linux-x86_64.deb'
          : undefined;
  return asset ? `https://github.com/4n5rud/SUPER-BOJ/releases/latest/download/super-boj-setup-${asset}` : undefined;
}
