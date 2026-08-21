import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 开发模式下把 /api 代理到本地 API Worker（wrangler dev，默认 8787）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
