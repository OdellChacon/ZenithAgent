import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo el panel corre en :5180 y le pasa /api a la API (:3100), así comparten
// origen y la cookie de sesión funciona sin CORS. (5173, el puerto por defecto de Vite,
// suele estar ocupado por otros proyectos.)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3100', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
