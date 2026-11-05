import { defineConfig } from "vite";

// In docker-compose the backend is reachable as http://backend:8000; locally it is on localhost.
const backend = process.env.BACKEND_URL ?? "http://localhost:8000";

export default defineConfig({
  build: {
    target: "es2022", // top-level await in main.ts
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
    },
  },
});
