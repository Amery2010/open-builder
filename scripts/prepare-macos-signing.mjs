import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function getMacosSigningEnvironment(env) {
  const certificate = (env.APPLE_CERTIFICATE ?? "").replace(/\s/g, "");
  const password = env.APPLE_CERTIFICATE_PASSWORD ?? "";
  const identity = (env.APPLE_SIGNING_IDENTITY ?? "").trim();
  const signing = {};

  if (certificate) {
    const decoded = Buffer.from(certificate, "base64");
    if (!decoded.length || decoded.toString("base64") !== certificate) {
      throw new Error("APPLE_CERTIFICATE must be a Base64-encoded .p12 file.");
    }
    signing.APPLE_CERTIFICATE = certificate;
    // A PKCS#12 file may legitimately have an empty password. Tauri needs both variables.
    signing.APPLE_CERTIFICATE_PASSWORD = password;
    if (identity) signing.APPLE_SIGNING_IDENTITY = identity;
  } else {
    if (password || (identity && identity !== "-")) {
      throw new Error(
        "Apple signing credentials are incomplete: configure APPLE_CERTIFICATE or remove the signing password and identity.",
      );
    }
    signing.APPLE_SIGNING_IDENTITY = "-";
  }

  const notarizationKeys = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  const configured = notarizationKeys.filter((key) => env[key]?.trim());
  if (configured.length && configured.length !== notarizationKeys.length) {
    throw new Error(
      "Apple notarization requires APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID together.",
    );
  }
  if (configured.length) {
    if (!certificate || identity === "-") {
      throw new Error(
        "Apple notarization requires a Developer ID signing certificate.",
      );
    }
    for (const key of notarizationKeys) signing[key] = env[key];
  }

  return signing;
}

export function verifyMacosCertificate(signing) {
  if (!signing.APPLE_CERTIFICATE) return;
  const args = [
    "pkcs12",
    "-passin",
    "env:APPLE_CERTIFICATE_PASSWORD",
    "-nodes",
  ];
  const options = {
    input: Buffer.from(signing.APPLE_CERTIFICATE, "base64"),
    env: { ...process.env, ...signing },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  };
  let result = spawnSync("openssl", args, options);
  // OpenSSL 3 needs legacy algorithms for some .p12 exports from Keychain Access.
  if (result.status !== 0) {
    result = spawnSync("openssl", [...args, "-legacy"], options);
  }
  if (
    result.status !== 0 ||
    !/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(result.stdout) ||
    !result.stdout.includes("-----BEGIN CERTIFICATE-----")
  ) {
    throw new Error(
      "Cannot read the Apple signing certificate and private key. Export both as a .p12 file, Base64-encode it, and check APPLE_CERTIFICATE_PASSWORD. OpenSSL must be installed.",
    );
  }
}

export function writeSigningEnvironment(outputPath, signing) {
  const entries = Object.entries(signing).map(([name, value]) => {
    let delimiter;
    do {
      delimiter = `apple-signing-${randomUUID()}`;
    } while (value.includes(delimiter));
    return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  });
  appendFileSync(outputPath, entries.join(""), "utf8");
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required.");
    const signing = getMacosSigningEnvironment(process.env);
    verifyMacosCertificate(signing);
    writeSigningEnvironment(process.env.GITHUB_ENV, signing);
    console.log(
      signing.APPLE_CERTIFICATE
        ? "Apple signing certificate preflight passed; Tauri will validate the signing identity."
        : "No Apple signing certificate configured; using ad-hoc signing without notarization.",
    );
  } catch (error) {
    console.error(`macos-signing: ${error.message}`);
    process.exitCode = 1;
  }
}
