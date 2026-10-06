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
    assetsInlineLimit: 4096,
    target: 'es2020',
    // Terser (2 passes, no comments/logs) beats the esbuild default here.
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      format: { comments: false }
    },
    cssCodeSplit: true,
    reportCompressedSize: true,
    // Split the engine from game code: parallel download + long-lived cache.
    rollupOptions: {
      output: {
        manualChunks: (id: string) => (id.includes('node_modules/phaser') ? 'phaser' : undefined)
      }
    },
    chunkSizeWarningLimit: 1600,
    commonjsOptions: {
      include: [/node_modules/]
    }
  }
});