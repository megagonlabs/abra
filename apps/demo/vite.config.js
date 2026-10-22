import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Client dev server. The hub runs separately (`pnpm --filter demo hub`) on :8787.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
