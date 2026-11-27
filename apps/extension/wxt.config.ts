import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { githubOrigins } from './adapters/github-origins';

declare const process: { env: Record<string, string | undefined> };
const key = process.env.SUPER_BOJ_EXTENSION_KEY;
const icons = { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' };
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'SUPER_BOJ',
    minimum_chrome_version: '116',
    permissions: ['sidePanel', 'storage', 'nativeMessaging', 'clipboardWrite'],
    host_permissions: ['https://www.acmicpc.net/*', 'https://acmicpc.net/*'],
    optional_host_permissions: [...githubOrigins],
    icons,
    action: { default_title: 'SUPER_BOJ 열기', default_icon: icons },
    ...(key ? { key } : {}),
  },
  vite: () => ({
    plugins: [tailwindcss()],
    define: {
      __SUPER_BOJ_STORE_EXTENSION_ID__: JSON.stringify(process.env.SUPER_BOJ_STORE_EXTENSION_ID ?? ''),
      __SUPER_BOJ_GITHUB_CLIENT_ID__: JSON.stringify(process.env.SUPER_BOJ_GITHUB_CLIENT_ID || 'Iv23liiSrTUhl8Es9Jzd'),
      __SUPER_BOJ_GITHUB_APP_SLUG__: JSON.stringify(process.env.SUPER_BOJ_GITHUB_APP_SLUG || 'super-boj'),
    },
  }),
});
