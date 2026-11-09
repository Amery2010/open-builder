import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;
const bundledDesignSkills: Plugin = {
  name: "bundled-design-skills",
  resolveId(id) {
    return id === "virtual:bundled-design-skills"
      ? "\0bundled-design-skills"
      : null;
  },
  load(id) {
    if (id !== "\0bundled-design-skills") return null;
    const skills = Object.fromEntries(
      ["design-product-ui", "art-direct-web"].map((name) => {
        const file = path.resolve(
          import.meta.dirname,
          "public/skills",
          name,
          "SKILL.md",
        );
        this.addWatchFile(file);
        return [name, readFileSync(file, "utf8")];
      }),
    );
    return `export default ${JSON.stringify(skills)};`;
  },
};

export default defineConfig(() => {
  return {
    base: process.env.VITE_BASE_PATH ?? "/",
    plugins: [react(), tailwindcss(), bundledDesignSkills],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 5173,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 5173,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
    build: {
      rolldownOptions: {
        output: {
          // Required while recursive dependency capture is disabled below;
          // otherwise lazy Markdown chunks can form invalid cycles.
          strictExecutionOrder: true,
          codeSplitting: {
            minSize: 20_000,
            maxSize: 480_000,
            includeDependenciesRecursively: false,
            groups: [
              {
                name: "chat-input",
                test: /src[\\/]components[\\/]chat[\\/](?:ChatInput\.tsx|chat-input[\\/](?!McpMenu\.tsx))/,
                minSize: 5_000,
                priority: 10,
              },
              {
                name: "vendor-editor",
                test: /node_modules[\\/](?:@codemirror|@lezer|codemirror)/,
                priority: 30,
              },
              {
                name: "vendor-sandpack",
                test: /node_modules[\\/](?:@codesandbox|react-devtools-inline|@stitches)/,
                priority: 25,
              },
              {
                name: "vendor-ai-openai",
                test: /node_modules[\\/]@ai-sdk[\\/]openai/,
                priority: 25,
              },
              {
                name: "vendor-ai-anthropic",
                test: /node_modules[\\/]@ai-sdk[\\/]anthropic/,
                priority: 25,
              },
              {
                name: "vendor-ai-google",
                test: /node_modules[\\/]@ai-sdk[\\/]google/,
                priority: 25,
              },
              {
                name: "vendor-ai-compatible",
                test: /node_modules[\\/]@ai-sdk[\\/]openai-compatible/,
                priority: 25,
              },
              {
                name: "vendor-ai-core",
                test: /node_modules[\\/](?:ai|@ai-sdk[\\/])/,
                priority: 20,
              },
              {
                name: "vendor-markdown",
                test: /node_modules[\\/](?:react-markdown|remark-|rehype-|highlight\.js|micromark|unified|mdast|hast|unist|vfile)/,
                priority: 20,
              },
              {
                name: "vendor-react",
                test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
                priority: 20,
              },
              {
                name: "vendor-radix",
                test: /node_modules[\\/](?:radix-ui|@radix-ui)/,
                priority: 15,
              },
              {
                name: "vendor-icons",
                test: /node_modules[\\/]lucide-react/,
                priority: 15,
              },
              {
                name: "vendor-shared",
                test: /node_modules/,
                minShareCount: 2,
                minSize: 30_000,
                maxSize: 480_000,
                priority: 1,
              },
            ],
          },
        },
      },
    },
    test: {
      environment: "node",
      setupFiles: ["./src/test/setup.ts"],
      execArgv: ["--no-experimental-webstorage"],
      // Node's built-in test runner owns these workflow tests. Excluding them
      // here prevents Vitest from executing the file and then reporting that it
      // contains no Vitest suite; `pnpm workflow:check` still runs it directly.
      exclude: [
        ...configDefaults.exclude,
        "e2e/**",
        "packages/**",
        "scripts/**/*.test.mjs",
      ],
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
  };
});
