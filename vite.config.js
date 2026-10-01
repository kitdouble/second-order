import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.API_PORT || 3000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Everything except the front end itself is served by the API.
    proxy: Object.fromEntries(
      ['/api', '/mcp', '/.well-known', '/authorize', '/token', '/register', '/revoke'].map((p) => [p, api])
    ),
  },
});
