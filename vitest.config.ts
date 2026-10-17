import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so unit tests of the pure logic in
// src/lib never boot the Cloudflare/Workers dev runtime.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
