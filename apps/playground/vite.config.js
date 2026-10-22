import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Standalone playground — views in isolation against abra-spec + abra-reducer,
// no hub. Runs the reduce loop in-process (apps/playground/src/loop.js).
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
});
