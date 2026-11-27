import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

declare const process: { env: Record<string, string | undefined> };
const key = process.env.SUPER_BOJ_EXTENSION_KEY;
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'SUPER_BOJ',
    minimum_chrome_version: '116',
    permissions: ['sidePanel', 'storage', 'nativeMessaging', 'clipboardWrite'],
    host_permissions: ['https://www.acmicpc.net/*', 'https://acmicpc.net/*'],
    action: { default_title: 'Open SUPER_BOJ' },
    ...(key ? { key } : {}),
  },
  vite: () => ({ plugins: [tailwindcss()] }),
});
