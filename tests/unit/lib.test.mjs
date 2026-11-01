// SPDX-License-Identifier: MIT
//
// Unit tests of src/lib.mjs, run with `node --test` by the `unit` check.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  LOCK_VERSION,
  isMetadataPath,
  isResolving,
  localRegistry,
  localizeMetadata,
  lockImporters,
  lockProblems,
  needsRegistry,
  outsideResolutions,
  parseFlowMap,
  pathOfGit,
  pathOfUrl,
  platformFilters,
  registryCredentials,
  registryLines,
  restoreLockText,
  rewriteLockText,
  tarballManifest,
  trimPackument,
  urlOfPath,
} from "../../src/lib.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const read = (p) => fs.readFileSync(path.join(fixtures, p), "utf8");

// A gzipped tar archive holding `files` (name to text), as npm packs a
// package.
function tarball(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("0", 156);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test("pathOfUrl keeps the scheme, host and path, and joins a port with %3A", () => {
  assert.equal(pathOfUrl("https://registry.npmjs.org/ms/-/ms-2.1.3.tgz"), "https/registry.npmjs.org/ms/-/ms-2.1.3.tgz");
  assert.equal(
    pathOfUrl("https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.25.12.tgz"),
    "https/registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.25.12.tgz",
  );
  assert.equal(pathOfUrl("http://localhost:4873/a/-/a-1.0.0.tgz"), "http/localhost%3A4873/a/-/a-1.0.0.tgz");
});

test("urlOfPath inverts pathOfUrl, and names no URL for a git path", () => {
  for (const url of ["https://registry.npmjs.org/ms/-/ms-2.1.3.tgz", "http://localhost:4873/a/-/a-1.0.0.tgz", "https://codeload.github.com/o/r/tar.gz/abc"]) {
    assert.equal(urlOfPath(pathOfUrl(url)), url);
  }
  assert.equal(urlOfPath("git/salsa.debian.org/js-team/node-ms/abc/package.tgz"), null);
  assert.equal(urlOfPath("https"), null);
});

test("pathOfGit names the host, repository, commit and directory", () => {
  assert.equal(
    pathOfGit("https://salsa.debian.org/js-team/node-ms.git", "abc"),
    "git/salsa.debian.org/js-team/node-ms/abc/package.tgz",
  );
  assert.equal(pathOfGit("git+https://example.com/r.git", "abc", "/packages/x/"), "git/example.com/r/abc/packages/x/package.tgz");
});

test("localRegistry mirrors an upstream registry on the local one", () => {
  assert.equal(localRegistry("http://127.0.0.1:1/", "https://registry.npmjs.org/"), "http://127.0.0.1:1/https/registry.npmjs.org/");
  assert.equal(localRegistry("http://127.0.0.1:1/", "https://npm.example.com/api"), "http://127.0.0.1:1/https/npm.example.com/api/");
});

test("parseFlowMap reads pnpm's resolution mappings", () => {
  assert.deepEqual(parseFlowMap("integrity: sha512-a+b/c==, tarball: https://x/y.tgz"), [
    ["integrity", "sha512-a+b/c=="],
    ["tarball", "https://x/y.tgz"],
  ]);
  assert.deepEqual(parseFlowMap("commit: abc, repo: https://h/r.git, type: git"), [
    ["commit", "abc"],
    ["repo", "https://h/r.git"],
    ["type", "git"],
  ]);
});

test("outsideResolutions finds the tarball URLs and git repositories of the sources fixture", () => {
  const found = outsideResolutions(read("sources/pnpm-lock.yaml"));
  assert.deepEqual(found.map((r) => r.kind).sort(), ["git", "url", "url", "url"]);
  assert.ok(found.some((r) => r.path === "https/registry.yarnpkg.com/is-odd/-/is-odd-3.0.1.tgz"));
  assert.ok(found.some((r) => r.path.startsWith("git/salsa.debian.org/js-team/node-ms/")));
});

test("outsideResolutions leaves registry packages and local files alone", () => {
  const text = [
    "  ms@2.1.3:",
    "    resolution: {integrity: sha512-abc}",
    "  packed@file:vendor/p.tgz:",
    "    resolution: {integrity: sha512-def, tarball: file:vendor/p.tgz}",
    "  vendored@file:vendor/v:",
    "    resolution: {directory: vendor/v, type: directory}",
  ].join("\n");
  assert.deepEqual(outsideResolutions(text), []);
  assert.deepEqual(outsideResolutions(read("workspace/pnpm-lock.yaml")), []);
});

test("rewriteLockText points outside resolutions at the local registry, and restoreLockText undoes it", () => {
  const original = read("sources/pnpm-lock.yaml");
  const base = "http://127.0.0.1:9/";
  const { text, pairs } = rewriteLockText(original, base, () => "sha512-served");
  assert.equal(pairs.length, 4);
  assert.ok(text.includes(`tarball: ${base}https/registry.yarnpkg.com/is-odd/-/is-odd-3.0.1.tgz`));
  assert.ok(!text.includes("tarball: https://registry.yarnpkg.com"));
  // A URL tarball keeps the integrity pnpm recorded.
  assert.match(text, /integrity: sha512-CQpnWPrDwmP1[^,]*, tarball: http:\/\/127\.0\.0\.1:9\/https\/registry\.yarnpkg\.com/);
  // A git repository becomes a git-hosted tarball with the served integrity.
  assert.match(text, /resolution: \{gitHosted: true, integrity: sha512-served, tarball: http:\/\/127\.0\.0\.1:9\/git\/salsa\.debian\.org\//);
  assert.equal(restoreLockText(text, pairs), original);
});

test("rewriteLockText refuses a git dependency the registry does not serve", () => {
  assert.throws(() => rewriteLockText(read("sources/pnpm-lock.yaml"), "http://127.0.0.1:9/", () => null), /pnpm-purifier lock/);
});

test("lockImporters reads the project document of a multi-document lockfile", () => {
  assert.deepEqual(lockImporters(read("workspace/pnpm-lock.yaml")), [".", "packages/app", "packages/greet"]);
  assert.deepEqual(lockImporters(read("sources/pnpm-lock.yaml")), ["."]);
  assert.deepEqual(lockImporters("lockfileVersion: '9.0'\n\nimporters:\n\n  'a b':\n    dependencies: {}\n\npackages: {}\n"), ["a b"]);
  assert.deepEqual(lockImporters("lockfileVersion: '9.0'\n"), ["."]);
});

test("registryLines maps the default and scoped registries and pins pnpm", () => {
  const lines = registryLines("http://127.0.0.1:1/", { default: "https://registry.npmjs.org/", scopes: { "@x": "https://x.example/npm/" } });
  assert.match(lines, /^registry=http:\/\/127\.0\.0\.1:1\/https\/registry\.npmjs\.org\/$/m);
  assert.match(lines, /^@x:registry=http:\/\/127\.0\.0\.1:1\/https\/x\.example\/npm\/$/m);
  assert.match(lines, /^manage-package-manager-versions=false$/m);
});

test("registryCredentials picks the longest matching prefix and expands variables", () => {
  const credentialsFor = registryCredentials(
    ["//npm.example.com/:_authToken=${TOKEN}\n//npm.example.com/private/:_authToken=deep\n", "//other.example/:_auth=dXNlcjpwYXNz\n"],
    { TOKEN: "outer" },
  );
  assert.deepEqual(credentialsFor("https://npm.example.com/a/-/a-1.tgz"), { authorization: "Bearer outer" });
  assert.deepEqual(credentialsFor("https://npm.example.com/private/a/-/a-1.tgz"), { authorization: "Bearer deep" });
  assert.deepEqual(credentialsFor("https://other.example/b"), { authorization: "Basic dXNlcjpwYXNz" });
  assert.deepEqual(credentialsFor("https://npm.example.community/a"), {});
  assert.deepEqual(credentialsFor("https://registry.npmjs.org/ms"), {});
});

test("tarballManifest and platformFilters read a package's package.json", () => {
  const native = tarball({ "package/package.json": JSON.stringify({ name: "n", os: ["darwin"], cpu: "arm64" }), "package/index.js": "x" });
  assert.equal(tarballManifest(native).name, "n");
  assert.deepEqual(platformFilters(native), { os: ["darwin"], cpu: ["arm64"] });
  const plain = tarball({ "package/index.js": "", "package/package.json": JSON.stringify({ name: "p" }) });
  assert.deepEqual(platformFilters(plain), {});
  assert.equal(tarballManifest(Buffer.from("not gzip")), null);
});

test("trimPackument keeps the recorded versions and drops the rest", () => {
  const doc = {
    name: "ms",
    readme: "long",
    "dist-tags": { latest: "2.1.3", old: "2.0.0" },
    versions: {
      "2.0.0": { version: "2.0.0", dist: { tarball: "https://registry.npmjs.org/ms/-/ms-2.0.0.tgz" } },
      "2.1.3": { version: "2.1.3", dist: { tarball: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz" } },
    },
    time: { created: "c", modified: "m", "2.0.0": "t0", "2.1.3": "t1" },
  };
  const trimmed = JSON.parse(trimPackument(Buffer.from(JSON.stringify(doc)), new Set(["https/registry.npmjs.org/ms/-/ms-2.0.0.tgz"])));
  assert.deepEqual(Object.keys(trimmed.versions), ["2.0.0"]);
  assert.deepEqual(trimmed["dist-tags"], { old: "2.0.0" });
  assert.deepEqual(trimmed.time, { created: "c", modified: "m", "2.0.0": "t0" });
  assert.equal(trimmed.readme, undefined);
  assert.equal(trimPackument(Buffer.from(JSON.stringify(doc)), new Set()), null);
  assert.equal(trimPackument(Buffer.from("<html>"), new Set()), null);
});

test("localizeMetadata names tarballs on the local registry", () => {
  const doc = { versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" } } } };
  const local = JSON.parse(localizeMetadata(JSON.stringify(doc), "http://127.0.0.1:5/"));
  assert.equal(local.versions["1.0.0"].dist.tarball, "http://127.0.0.1:5/https/registry.npmjs.org/a/-/a-1.0.0.tgz");
});

test("isMetadataPath is true for package names under a registry host only", () => {
  for (const p of ["https/registry.npmjs.org/ms", "https/registry.npmjs.org/@esbuild/linux-x64", "http/localhost%3A4873/a"]) {
    assert.equal(isMetadataPath(p), true, p);
  }
  for (const p of [
    "https/registry.npmjs.org/ms/-/ms-2.1.3.tgz",
    "https/codeload.github.com/o/r/tar.gz/abc",
    "https/registry.npmjs.org/a/b",
    "git/salsa.debian.org/js-team/node-ms/abc/package.tgz",
    "https/registry.npmjs.org/",
  ]) {
    assert.equal(isMetadataPath(p), false, p);
  }
});

test("isResolving tells resolving commands from offline ones", () => {
  for (const args of [["add", "ms"], ["update"], ["up", "--latest"], ["remove", "ms"], ["install", "ms"], ["i", "-D", "ms"], ["--filter", "x", "add", "y"]]) {
    assert.equal(isResolving(args), true, args.join(" "));
  }
  for (const args of [[], ["install"], ["i", "--frozen-lockfile"], ["run", "build"], ["test"], ["exec", "tsc"], ["-r", "run", "build"]]) {
    assert.equal(isResolving(args), false, args.join(" "));
  }
});

test("needsRegistry is true for installing commands only", () => {
  for (const args of [[], ["install"], ["i", "--frozen-lockfile"], ["--filter", "x", "install"], ["deploy", "out"], ["rebuild"]]) {
    assert.equal(needsRegistry(args), true, args.join(" "));
  }
  for (const args of [["run", "build"], ["test"], ["exec", "tsc"], ["build"], ["-r", "run", "build"], ["why", "ms"]]) {
    assert.equal(needsRegistry(args), false, args.join(" "));
  }
});

test("lockProblems accepts the fixture locks and names what is wrong with others", () => {
  for (const f of ["workspace", "sources", "prepare"]) {
    assert.deepEqual(lockProblems(JSON.parse(read(`${f}/pnpm-purifier.lock.json`))), [], f);
  }
  const good = JSON.parse(read("workspace/pnpm-purifier.lock.json"));
  assert.match(lockProblems([])[0], /not a JSON object/);
  assert.match(lockProblems({ ...good, version: LOCK_VERSION + 1 })[0], /format/);
  assert.ok(lockProblems({ ...good, artifacts: "x" }).some((p) => /artifacts is not a list/.test(p)));
  const tampered = { ...good, artifacts: [{ ...good.artifacts[0], hash: "sha256-short" }] };
  assert.ok(lockProblems(tampered).some((p) => /sha256 hash/.test(p)));
  const noUrl = { ...good, artifacts: [{ path: "https/x/y.tgz", mirrors: [], hash: good.artifacts[0].hash }] };
  assert.ok(lockProblems(noUrl).some((p) => /no url/.test(p)));
});
