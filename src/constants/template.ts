export const VITE_REACT_TYPESCRIPT_TEMPLATE = {
  files: {
    "/src/App.tsx": {
      code: `export default function App() {
  const data: string = "world"

  return <h1 className="text-xl">Hello {data}</h1>
}`,
    },
    "/src/main.tsx": {
      code: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);`,
    },
    "/src/vite-env.d.ts": {
      code: '/// <reference types="vite/client" />',
    },
    "/index.html": {
      code: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite App</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    "/tsconfig.json": {
      code: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2020",
            useDefineForClassFields: true,
            lib: ["ES2020", "DOM", "DOM.Iterable"],
            module: "ESNext",
            skipLibCheck: true,
            types: ["node"],

            /* Bundler mode */
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
            jsx: "react-jsx",

            /* Path mapping */
            baseUrl: ".",
            paths: {
              "@/*": ["src/*"],
            },

            /* Linting */
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noFallthroughCasesInSwitch: true,
          },
          include: ["src", "vite.config.ts"],
        },
        null,
        2,
      ),
    },
    "/package.json": {
      code: JSON.stringify(
        {
          name: "react-vite-ts",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            dev: "vite",
            build: "tsc && vite build",
            preview: "vite preview",
          },
          dependencies: {
            react: "19.2.4",
            "react-dom": "19.2.4",
          },
          devDependencies: {
            "@types/react": "19.2.14",
            "@types/react-dom": "19.2.3",
            "@vitejs/plugin-react": "4.3.4",
            typescript: "5.9.3",
            vite: "4.2.0",
            "esbuild-wasm": "0.27.3",
          },
        },
        null,
        2,
      ),
    },
    "/vite.config.ts": {
      code: `import path from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});`,
    },
  },
  main: "/src/main.tsx",
  environment: "node",
};
