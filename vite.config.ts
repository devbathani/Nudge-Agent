import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

// NUDGE_OFFLINE=1 boots the Worker without Cloudflare credentials by turning
// off remote bindings. Workers AI is then unavailable, so chat replies show a
// friendly error and nudges fall back to built-in templates.
const offline = process.env.NUDGE_OFFLINE === "1";

export default defineConfig({
  plugins: [
    agents(),
    react(),
    cloudflare({ remoteBindings: !offline }),
    tailwindcss()
  ]
});
