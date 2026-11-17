import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  // no hardcoded port dependency — honors the harness-assigned PORT, defaults to 5180
  server: { port: Number(process.env.PORT) || 5180, host: true },
});
