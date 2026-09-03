import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASE_TAG_PATTERN =
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function normalizedVersion(value) {
  return value.startsWith("v") ? value.slice(1) : value;
}

export function extractReleaseNotes(changelogSource, releaseTag) {
  if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error(
      `Expected a semantic release tag beginning with "v", received "${releaseTag}".`,
    );
  }

  const source = changelogSource.replace(/\r\n?/g, "\n");
  const targetVersion = normalizedVersion(releaseTag);
  const matchingHeadings = [
    ...source.matchAll(
      /^##[ \t]+\[([^\]\n]+)\](?:[ \t]+-[ \t]+[^\n]+)?[ \t]*$/gm,
    ),
  ].filter((match) => normalizedVersion(match[1].trim()) === targetVersion);

  if (matchingHeadings.length === 0) {
    throw new Error(
      `CHANGELOG.md has no level-two section for release tag "${releaseTag}".`,
    );
  }
  if (matchingHeadings.length > 1) {
    throw new Error(
      `CHANGELOG.md has multiple level-two sections for release tag "${releaseTag}".`,
    );
  }

  const heading = matchingHeadings[0];
  const bodyStart = heading.index + heading[0].length;
  const remainingSource = source.slice(bodyStart);
  const nextHeadingOffset = remainingSource.search(/^##(?:[ \t]+|$)/m);
  const sectionSource =
    nextHeadingOffset === -1
      ? remainingSource
      : remainingSource.slice(0, nextHeadingOffset);
  const releaseNotes = sectionSource
    .trim()
    .replace(/(?:^|\n)[ \t]*---[ \t]*$/, "")
    .trim();

  if (releaseNotes.length === 0) {
    throw new Error(
      `CHANGELOG.md section for release tag "${releaseTag}" is empty.`,
    );
  }

  return releaseNotes;
}

function writeGitHubOutput(outputPath, releaseNotes) {
  let delimiter;
  do {
    delimiter = `release-notes-${randomUUID()}`;
  } while (releaseNotes.includes(delimiter));

  appendFileSync(
    outputPath,
    `body<<${delimiter}\n${releaseNotes}\n${delimiter}\n`,
    "utf8",
  );
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const releaseTag = process.argv[2] ?? process.env.RELEASE_TAG ?? "";
    const changelogPath =
      process.argv[3] ??
      fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
    const changelogSource = readFileSync(changelogPath, "utf8");
    const releaseNotes = extractReleaseNotes(changelogSource, releaseTag);

    if (process.env.GITHUB_OUTPUT) {
      writeGitHubOutput(process.env.GITHUB_OUTPUT, releaseNotes);
    } else {
      process.stdout.write(`${releaseNotes}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`release-notes: ${message}`);
    process.exitCode = 1;
  }
}
