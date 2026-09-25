import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base so the build works on GitHub Pages sub-paths, from the companion server, or from disk.
  base: './',
  // Use PORT when a tool assigns one (e.g. a preview runner); otherwise Vite's default 5173.
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'sample/*'],
      manifest: {
        name: 'PitView — FRC Driver Station Log Viewer',
        short_name: 'PitView',
        description: 'View FRC Driver Station .dslog and .dsevents files. Works offline.',
        theme_color: '#12151b',
        background_color: '#12151b',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [
          {
            action: './',
            accept: { 'application/octet-stream': ['.dslog', '.dsevents'] },
          },
        ],
        launch_handler: { client_mode: 'focus-existing' },
      } as never,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}', 'sample/*'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  worker: { format: 'es' },
  test: {
    include: ['test/**/*.test.ts'],
  },
} as never);
