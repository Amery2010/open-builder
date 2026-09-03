import { existsSync, readFileSync, readdirSync } from "node:fs";

const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const files = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));
const failures = [];
let tagReleaseWorkflows = 0;

for (const file of files) {
  const source = readFileSync(new URL(file, workflowsDir), "utf8");
  if (/tags:\s*\n(?:\s+-[^\n]*\n)*\s+-\s*["']?v\*/m.test(source)) {
    tagReleaseWorkflows += 1;
  }
  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const action = match[1];
    if (!/@[0-9a-f]{40}$/.test(action)) {
      failures.push(
        `${file}: action is not pinned to a full commit SHA: ${action}`,
      );
    }
  }
}

if (tagReleaseWorkflows !== 1) {
  failures.push(
    `Expected exactly one v* tag release workflow, found ${tagReleaseWorkflows}.`,
  );
}

const release = readFileSync(new URL("release.yml", workflowsDir), "utf8");
if (!/\brelease:\s*\n\s+needs:\s+quality\b/.test(release)) {
  failures.push(
    "release.yml must require the quality job before publishing assets.",
  );
}
if (!/releaseDraft:\s*true/.test(release)) {
  failures.push("release.yml must create a draft release.");
}
const extractReleaseNotesStep = release.indexOf(
  "- name: Extract release notes",
);
const buildAndReleaseStep = release.indexOf("- name: Build and release");
if (
  extractReleaseNotesStep === -1 ||
  buildAndReleaseStep === -1 ||
  extractReleaseNotesStep > buildAndReleaseStep
) {
  failures.push(
    "release.yml must extract release notes before building the release.",
  );
}
if (!/^\s+id:\s*release-notes\s*$/m.test(release)) {
  failures.push("release.yml release-note extraction step must keep its id.");
}
if (!/^\s+RELEASE_TAG:\s*\$\{\{\s*github\.ref_name\s*\}\}\s*$/m.test(release)) {
  failures.push("release.yml must derive release notes from github.ref_name.");
}
if (!/^\s+run:\s*node scripts\/extract-release-notes\.mjs\s*$/m.test(release)) {
  failures.push("release.yml must run the checked-in release-note extractor.");
}
if (
  !/^\s+releaseBody:\s*\$\{\{\s*steps\.release-notes\.outputs\.body\s*\}\}\s*$/m.test(
    release,
  )
) {
  failures.push(
    "release.yml must use the extracted CHANGELOG section as its release body.",
  );
}
if (/See CHANGELOG\.md and the attached desktop installers\./.test(release)) {
  failures.push("release.yml must not publish the legacy placeholder body.");
}
for (const file of [
  "../../scripts/extract-release-notes.mjs",
  "../../scripts/extract-release-notes.test.mjs",
]) {
  if (!existsSync(new URL(file, workflowsDir))) {
    failures.push(`Required release-note contract file is missing: ${file}`);
  }
}
if (existsSync(new URL("changelog.yml", workflowsDir))) {
  failures.push(
    "The legacy duplicate changelog release workflow must be removed.",
  );
}

for (const file of ["release-ios.yml", "release-android.yml"]) {
  const source = readFileSync(new URL(file, workflowsDir), "utf8");
  if (
    !/^on:\s*\n\s+workflow_dispatch:\s*$/m.test(source) ||
    /\btags:\s*$/m.test(source)
  ) {
    failures.push(`${file} must remain manual-only and experimental.`);
  }
}

const license = readFileSync(new URL("../../LICENSE", workflowsDir), "utf8");
const readme = readFileSync(new URL("../../README.md", workflowsDir), "utf8");
const readmeZh = readFileSync(
  new URL("../../README.zh-CN.md", workflowsDir),
  "utf8",
);
if (!license.startsWith("GNU GENERAL PUBLIC LICENSE")) {
  failures.push("LICENSE must contain the declared GPLv3 license text.");
}
if (/license-MIT/i.test(readme) || /license-MIT/i.test(readmeZh)) {
  failures.push("README license badges must match GPLv3.");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`workflow: ${failure}`);
  process.exit(1);
}

console.log("Workflow, release, and license checks passed.");
