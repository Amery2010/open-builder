import {
  applyDesignSystemPackage,
  type DesignSystemPackage,
  type ProjectFiles,
} from "@open-builder/core";

export function listTemplates(): Array<{
  id: string;
  name: string;
  tasks: string[];
}> {
  return [
    {
      id: "react-ts",
      name: "React + TypeScript + Vite (native)",
      tasks: ["build", "typecheck"],
    },
    { id: "static", name: "HTML + CSS + JavaScript", tasks: [] },
  ];
}

const styles = `* { box-sizing: border-box; }
body { margin: 0; background: var(--bg, #fafafa); color: var(--fg, #202124); font-family: var(--font-body, system-ui, sans-serif); line-height: 1.5; }
main { max-width: var(--container-max, 64rem); margin: 0 auto; padding: var(--section-y-desktop, 4rem) 1.5rem; }
h1 { font-family: var(--font-display, inherit); line-height: 1.15; }
button { font: inherit; padding: .6em 1em; border: 1px solid var(--border, #ccc); border-radius: var(--radius-md, .4rem); background: var(--accent, #2447d8); color: var(--accent-on, #fff); cursor: pointer; }
button:focus-visible { outline: 2px solid var(--fg, #202124); outline-offset: 3px; }
`;

export function createTemplateFiles(
  template: string,
  design?: DesignSystemPackage,
): ProjectFiles {
  let files: ProjectFiles;
  if (template === "static") {
    files = {
      "index.html": `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My application</title><link rel="stylesheet" href="./styles.css"></head>
<body><main><h1>My application</h1><p>Edit this page to get started.</p><button id="counter" type="button">Count: 0</button></main><script type="module" src="./app.js"></script></body></html>
`,
      "styles.css": styles,
      "app.js": `let count = 0;
document.querySelector('#counter').addEventListener('click', (event) => {
  count += 1;
  event.currentTarget.textContent = 'Count: ' + count;
});
`,
    };
  } else if (template === "react-ts") {
    files = {
      "package.json": `${JSON.stringify(
        {
          name: "my-application",
          version: "0.0.0",
          private: true,
          type: "module",
          scripts: {
            dev: "vite",
            build: "tsc --noEmit && vite build",
            typecheck: "tsc --noEmit",
          },
          dependencies: { react: "19.2.8", "react-dom": "19.2.8" },
          devDependencies: {
            "@types/react": "19.2.18",
            "@types/react-dom": "19.2.4",
            "@vitejs/plugin-react": "6.1.0",
            typescript: "6.0.3",
            vite: "8.2.2",
          },
          engines: { node: ">=24 <25" },
        },
        null,
        2,
      )}\n`,
      "index.html": `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My application</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
`,
      "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: true }, include: ["src", "vite.config.ts"] }, null, 2)}\n`,
      "vite.config.ts": `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()] });
`,
      "src/main.tsx": `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
`,
      "src/vite-env.d.ts": '/// <reference types="vite/client" />\n',
      "src/App.tsx": `import { useState } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  return <main><h1>My application</h1><p>Edit this page to get started.</p><button type="button" onClick={() => setCount(count + 1)}>Count: {count}</button></main>;
}
`,
      "src/styles.css": styles,
      ".gitignore": "node_modules/\ndist/\n*.local\n",
    };
  } else {
    throw new Error(`Unknown template "${template}". Use templates list.`);
  }
  if (design) {
    files = applyDesignSystemPackage(files, design).files;
    const path = template === "static" ? "styles.css" : "src/styles.css";
    const tokenPath = template === "static" ? "./tokens.css" : "../tokens.css";
    files[path] = `@import "${tokenPath}";\n${files[path]}`;
  }
  return files;
}
