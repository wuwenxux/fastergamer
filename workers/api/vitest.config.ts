import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // workerd 内置模块，node 侧测试用同形桩替代（src/__tests__/stubs/cloudflare-workers.ts）
      "cloudflare:workers": new URL("./src/__tests__/stubs/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
});
