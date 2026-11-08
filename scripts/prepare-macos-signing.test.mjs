import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  getMacosSigningEnvironment,
  verifyMacosCertificate,
  writeSigningEnvironment,
} from "./prepare-macos-signing.mjs";

const directory = mkdtempSync(join(tmpdir(), "open-builder-signing-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

test("unset and empty secrets use ad-hoc signing without certificate or notary variables", () => {
  assert.deepEqual(getMacosSigningEnvironment({}), {
    APPLE_SIGNING_IDENTITY: "-",
  });
  assert.deepEqual(
    getMacosSigningEnvironment({
      APPLE_CERTIFICATE: "",
      APPLE_CERTIFICATE_PASSWORD: "",
      APPLE_SIGNING_IDENTITY: "",
      APPLE_ID: "",
      APPLE_PASSWORD: "",
      APPLE_TEAM_ID: "",
    }),
    { APPLE_SIGNING_IDENTITY: "-" },
  );
});

test("orphaned signing credentials fail instead of falling back to ad-hoc signing", () => {
  for (const env of [
    { APPLE_CERTIFICATE_PASSWORD: "password" },
    { APPLE_SIGNING_IDENTITY: "Developer ID Application: Example" },
  ]) {
    assert.throws(() => getMacosSigningEnvironment(env), /incomplete/);
  }
});

test("malformed Base64 is rejected before import", () => {
  assert.throws(
    () => getMacosSigningEnvironment({ APPLE_CERTIFICATE: "not a .p12!" }),
    /Base64-encoded .p12/,
  );
});

test("certificate whitespace is normalized, empty passwords and inferred identity are supported", () => {
  assert.deepEqual(
    getMacosSigningEnvironment({ APPLE_CERTIFICATE: " Zml4\ndHVyZQ==\n" }),
    { APPLE_CERTIFICATE: "Zml4dHVyZQ==", APPLE_CERTIFICATE_PASSWORD: "" },
  );
});

test("notarization requires all three credentials and a signing certificate", () => {
  for (const env of [
    { APPLE_ID: "fixture@example.com" },
    { APPLE_PASSWORD: "fixture-password", APPLE_TEAM_ID: "TEAM" },
  ]) {
    assert.throws(() => getMacosSigningEnvironment(env), /together/);
  }
  const notarization = {
    APPLE_ID: "fixture@example.com",
    APPLE_PASSWORD: "fixture-password",
    APPLE_TEAM_ID: "TEAM",
  };
  assert.throws(() => getMacosSigningEnvironment(notarization), /Developer ID/);
  assert.deepEqual(
    getMacosSigningEnvironment({
      ...notarization,
      APPLE_CERTIFICATE: "Zml4dHVyZQ==",
    }),
    {
      ...notarization,
      APPLE_CERTIFICATE: "Zml4dHVyZQ==",
      APPLE_CERTIFICATE_PASSWORD: "",
    },
  );
});

test("environment export preserves multiline and empty passwords without creating extra variables", () => {
  const output = join(directory, "multiline.env");
  const password = "first\nINJECTED=value\nlast";
  writeSigningEnvironment(output, { APPLE_CERTIFICATE_PASSWORD: password });
  const [header, ...rest] = readFileSync(output, "utf8").split("\n");
  const delimiter = header.split("<<")[1];
  assert.equal(header.split("<<")[0], "APPLE_CERTIFICATE_PASSWORD");
  assert.equal(rest.join("\n"), `${password}\n${delimiter}\n`);
});

test("the workflow entry point exports no empty certificate variables or secret log values", () => {
  const output = join(directory, "empty.env");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("APPLE_")),
  );
  const script = fileURLToPath(
    new URL("prepare-macos-signing.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [script], {
    env: {
      ...env,
      GITHUB_ENV: output,
      APPLE_CERTIFICATE: "",
      APPLE_CERTIFICATE_PASSWORD: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ad-hoc/);
  assert.doesNotMatch(readFileSync(output, "utf8"), /APPLE_CERTIFICATE/);

  const invalidOutput = join(directory, "invalid.env");
  const secret = "invalid-certificate-SECRET";
  const invalid = spawnSync(process.execPath, [script], {
    env: { ...env, GITHUB_ENV: invalidOutput, APPLE_CERTIFICATE: secret },
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(
    invalid.stdout + invalid.stderr,
    /invalid-certificate-SECRET/,
  );
});

test("PKCS#12 preflight accepts private keys and rejects bad passwords, invalid files, and missing keys", () => {
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Open Builder signing test",
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { stdio: "ignore" },
  );

  for (const password of ["fixture-password", ""]) {
    const p12 = join(directory, `certificate-${password || "empty"}.p12`);
    execFileSync(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-inkey",
        key,
        "-in",
        certificate,
        "-out",
        p12,
        "-passout",
        "env:FIXTURE_PASSWORD",
      ],
      { env: { ...process.env, FIXTURE_PASSWORD: password }, stdio: "ignore" },
    );
    const signing = {
      APPLE_CERTIFICATE: readFileSync(p12).toString("base64"),
      APPLE_CERTIFICATE_PASSWORD: password,
    };
    assert.doesNotThrow(() => verifyMacosCertificate(signing));
    assert.throws(
      () =>
        verifyMacosCertificate({
          ...signing,
          APPLE_CERTIFICATE_PASSWORD: "wrong",
        }),
      /Cannot read/,
    );
  }
  assert.throws(
    () =>
      verifyMacosCertificate({
        APPLE_CERTIFICATE: "Zml4dHVyZQ==",
        APPLE_CERTIFICATE_PASSWORD: "",
      }),
    /Cannot read/,
  );
  const withoutKey = join(directory, "without-key.p12");
  execFileSync(
    "openssl",
    [
      "pkcs12",
      "-export",
      "-nokeys",
      "-in",
      certificate,
      "-out",
      withoutKey,
      "-passout",
      "pass:",
    ],
    { stdio: "ignore" },
  );
  assert.throws(
    () =>
      verifyMacosCertificate({
        APPLE_CERTIFICATE: readFileSync(withoutKey).toString("base64"),
        APPLE_CERTIFICATE_PASSWORD: "",
      }),
    /Cannot read/,
  );
});
