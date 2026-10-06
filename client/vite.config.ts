import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build works from any path:
  // GitHub Pages project sites, forks, custom domains, Capacitor.
  base: './',
  server: {
    port: 3000,
    strictPort: true,
    open: true
  },
  preview: {
    port: 3000,
    strictPort: true
  },
  build: {
    assetsInlineLimit: 0,
    target: 'es2020',
    commonjsOptions: {
      include: [/node_modules/]
    }
  }
});
