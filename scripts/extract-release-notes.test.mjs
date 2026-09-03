import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractReleaseNotes } from "./extract-release-notes.mjs";

test("extracts the exact v-prefixed release section", () => {
  const changelog = `# Changelog

## [v2.0.0]

### Added

- Current release.

## [v1.9.0]

- Previous release.
`;

  assert.equal(
    extractReleaseNotes(changelog, "v2.0.0"),
    "### Added\n\n- Current release.",
  );
});

test("supports legacy headings without v and removes a trailing separator", () => {
  const changelog = `# Changelog\r
\r
## [1.3.0] - 2026-03-14\r
\r
### Fixed\r
\r
- Legacy release.\r
\r
---\r
\r
## [1.2.0] - 2026-03-06\r
\r
- Older release.\r
`;

  assert.equal(
    extractReleaseNotes(changelog, "v1.3.0"),
    "### Fixed\n\n- Legacy release.",
  );
});

test("rejects a tag without a matching changelog section", () => {
  assert.throws(
    () => extractReleaseNotes("# Changelog\n", "v3.0.0"),
    /no level-two section/,
  );
});

test("rejects duplicate normalized release headings", () => {
  const changelog = `## [v2.0.0]

- First.

## [2.0.0] - 2026-09-03

- Duplicate.
`;

  assert.throws(
    () => extractReleaseNotes(changelog, "v2.0.0"),
    /multiple level-two sections/,
  );
});

test("rejects empty release notes and non-semantic tags", () => {
  assert.throws(
    () => extractReleaseNotes("## [v2.0.0]\n", "v2.0.0"),
    /is empty/,
  );
  assert.throws(
    () => extractReleaseNotes("## [latest]\n\n- Notes.\n", "latest"),
    /semantic release tag/,
  );
});

test("writes multiline release notes to GITHUB_OUTPUT", (context) => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "open-builder-release-notes-"),
  );
  context.after(() =>
    rmSync(temporaryDirectory, { force: true, recursive: true }),
  );

  const changelogPath = join(temporaryDirectory, "CHANGELOG.md");
  const outputPath = join(temporaryDirectory, "github-output.txt");
  writeFileSync(
    changelogPath,
    "## [v2.0.0]\n\n### Added\n\n- Published from the changelog.\n",
  );

  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./extract-release-notes.mjs", import.meta.url)),
      "v2.0.0",
      changelogPath,
    ],
    {
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    },
  );

  const output = readFileSync(outputPath, "utf8");
  const [openingLine] = output.split("\n");
  const delimiter = openingLine.slice("body<<".length);
  assert.match(delimiter, /^release-notes-[0-9a-f-]+$/);
  assert.equal(
    output,
    `body<<${delimiter}\n### Added\n\n- Published from the changelog.\n${delimiter}\n`,
  );
});
