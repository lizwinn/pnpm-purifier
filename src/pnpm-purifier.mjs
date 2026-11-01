#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// pnpm-purifier: the lock run, and the local registry that pnpm reads
// through in every mode.
//
//   pnpm-purifier lock               runs the lock run in the current
//                                    directory and writes pnpm-purifier.lock.json
//   pnpm-purifier exec --manifest M -- CMD...
//                                    runs CMD with pnpm pointed at a registry
//                                    that serves only the files in M (the Nix
//                                    build uses this)
//   pnpm-purifier [PNPM ARGS...]     runs pnpm on the locked downloads,
//                                    realized through Nix, offline
//
// The registry is an HTTP server on the loopback interface. Its URL space
// mirrors the upstream URLs: GET /https/registry.npmjs.org/ms/-/ms-2.1.3.tgz
// stands for https://registry.npmjs.org/ms/-/ms-2.1.3.tgz. That relative
// path is also the `path` of the file in the lockfile.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const LOCK_FILE = "pnpm-purifier.lock.json";
const LOCK_VERSION = 1;
const STATE_DIR = ".pnpm-purifier";

// The Nix systems a lock covers. pnpm installs the optional dependencies of
// every listed platform during the lock run, so the lock holds the native
// packages (such as @esbuild/linux-arm64) of each system.
const LOCK_PLATFORMS = { os: ["linux", "darwin"], cpu: ["x64", "arm64"], libc: ["glibc"] };

const selfPath = fileURLToPath(import.meta.url);

function fail(message) {
  console.error(`pnpm-purifier: ${message}`);
  process.exit(1);
}

function sri(buffer) {
  return "sha256-" + createHash("sha256").update(buffer).digest("base64");
}

function hexDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// The lockfile path of an upstream URL: the scheme, the host (a port joins
// it with "%3A"), then the URL path, as in /https/registry.npmjs.org/ms/...
function pathOfUrl(url) {
  const u = new URL(url);
  const scheme = u.protocol.replace(/:$/, "");
  const host = u.port ? `${u.hostname}%3A${u.port}` : u.hostname;
  return `${scheme}/${host}${u.pathname}`;
}

function urlOfPath(relPath) {
  const [scheme, host, ...rest] = relPath.split("/");
  if (scheme !== "https" && scheme !== "http") return null;
  return `${scheme}://${host.replace("%3A", ":")}/${rest.join("/")}`;
}

// The registry URL pnpm uses for an upstream registry, on a server at
// `base` (http://127.0.0.1:PORT/).
function localRegistry(base, upstream) {
  const p = pathOfUrl(upstream);
  return base + (p.endsWith("/") ? p : p + "/");
}

// The .npmrc lines that point each upstream registry of the lock at its
// local mirror, and keep pnpm on the version that runs: a `packageManager`
// field naming another version otherwise makes pnpm download that one.
function registryLines(base, registries) {
  const lines = [`registry=${localRegistry(base, registries.default)}`];
  for (const [scope, url] of Object.entries(registries.scopes ?? {})) {
    lines.push(`${scope}:registry=${localRegistry(base, url)}`);
  }
  lines.push("manage-package-manager-versions=false", "pm-on-fail=ignore", "update-notifier=false");
  return lines.join("\n") + "\n";
}

// The environment that configures pnpm for the local registry. pnpm reads
// scoped registries from .npmrc files only, so the registries go into a
// user config file in `dir`, which starts with the user config that was in
// effect. pnpm 11 reads its other settings from the environment only.
function pnpmConfigEnv(base, registries, dir) {
  const previous = process.env.npm_config_userconfig ?? path.join(os.homedir(), ".npmrc");
  const own = fs.existsSync(previous) ? fs.readFileSync(previous, "utf8") + "\n" : "";
  const userconfig = path.join(dir, "npmrc");
  fs.writeFileSync(userconfig, own + registryLines(base, registries));
  return {
    npm_config_userconfig: userconfig,
    pnpm_config_registry: localRegistry(base, registries.default),
    pnpm_config_pm_on_fail: "ignore",
    pnpm_config_update_notifier: "false",
  };
}

// A project .npmrc takes precedence over the user config, so in a copy of
// the project that the purifier owns the registry lines go there too.
function pinProjectRegistries(projectDir, base, registries) {
  const rc = path.join(projectDir, ".npmrc");
  if (fs.existsSync(rc)) fs.appendFileSync(rc, "\n" + registryLines(base, registries));
}

// The package.json of an npm package tarball (a gzipped tar archive with
// the package under one top-level directory), or null.
function tarballManifest(buffer) {
  let tar;
  try {
    tar = zlib.gunzipSync(buffer);
  } catch {
    return null;
  }
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const name = field(345, 155) ? `${field(345, 155)}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const body = offset + 512;
    if (/^[^/]+\/package\.json$/.test(name)) {
      try {
        return JSON.parse(tar.subarray(body, body + size).toString("utf8"));
      } catch {
        return null;
      }
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

// npm's platform filters of a package: the `os`, `cpu` and `libc` lists of
// its package.json, each kept only where the package sets it.
function platformFilters(buffer) {
  const manifest = tarballManifest(buffer) ?? {};
  const filters = {};
  for (const key of ["os", "cpu", "libc"]) {
    const value = manifest[key];
    if (Array.isArray(value) && value.length > 0) filters[key] = value;
    else if (typeof value === "string") filters[key] = [value];
  }
  return filters;
}

// Registry metadata (packuments) changes whenever a package publishes, so
// it cannot be locked by hash. A frozen install reads tarballs only.
function isMetadata(contentType) {
  return /json/.test(contentType ?? "");
}

// Starts the local registry. `lookup(relPath)` returns a file path to serve
// or null; `record(relPath, url)`, when given, fetches the URL upstream.
function startRegistry({ lookup, record }) {
  const server = http.createServer(async (req, res) => {
    const relPath = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      if (record) {
        const { status, contentType, body } = await record(relPath);
        res.writeHead(status, { "content-type": contentType ?? "application/octet-stream" });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      const file = lookup(relPath);
      if (file == null) {
        const url = urlOfPath(relPath) ?? relPath;
        console.error(`pnpm-purifier: ${url} is not in ${LOCK_FILE}; run \`pnpm-purifier lock\``);
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `not locked: ${url}` }));
        return;
      }
      const stat = fs.statSync(file);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": stat.size });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error(`pnpm-purifier: ${relPath}: ${err.message}`);
      res.writeHead(502).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", (err) => fail(`cannot run ${command}: ${err.message}`));
    child.on("exit", (code, signal) => resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : code));
  });
}

function capture(command, args, options) {
  const r = spawnSync(command, args, { encoding: "utf8", ...options });
  if (r.error) fail(`cannot run ${command}: ${r.error.message}`);
  if (r.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
}

// The pnpm that runs: PNPM_PURIFIER_PNPM when set; otherwise, when
// PNPM_PURIFIER_PNPMS (a JSON object from major version to pnpm
// executable, which the flake's package sets) has the major version of the
// project's `packageManager` field, that one; otherwise `pnpm` from PATH.
function pnpmCommand(root = process.cwd()) {
  if (process.env.PNPM_PURIFIER_PNPM) return process.env.PNPM_PURIFIER_PNPM;
  const byMajor = JSON.parse(process.env.PNPM_PURIFIER_PNPMS ?? "{}");
  const manifestFile = path.join(root, "package.json");
  if (fs.existsSync(manifestFile)) {
    const field = JSON.parse(fs.readFileSync(manifestFile, "utf8")).packageManager ?? "";
    const m = field.match(/^pnpm@(\d+)\./);
    if (m && byMajor[m[1]]) return byMajor[m[1]];
  }
  return "pnpm";
}

// Environment variables that keep pnpm's state inside `dir`, as in the Nix
// sandbox.
function isolatedEnv(dir) {
  const env = {
    HOME: path.join(dir, "home"),
    XDG_CACHE_HOME: path.join(dir, "home/.cache"),
    XDG_CONFIG_HOME: path.join(dir, "home/.config"),
    XDG_DATA_HOME: path.join(dir, "home/.local/share"),
    XDG_STATE_HOME: path.join(dir, "home/.local/state"),
    XDG_RUNTIME_DIR: path.join(dir, "run"),
  };
  for (const d of Object.values(env)) fs.mkdirSync(d, { recursive: true });
  return env;
}

// The registries the project resolves from, as pnpm configures them for
// it: the default registry, and one per scope that names its own.
function projectRegistries(root) {
  const pnpm = pnpmCommand(root);
  const listed = JSON.parse(capture(pnpm, ["config", "list", "--json"], { cwd: root }));
  const scopes = {};
  for (const [key, value] of Object.entries(listed)) {
    const m = key.match(/^(@[^:]+):registry$/);
    if (m) scopes[m[1]] = value;
  }
  return { default: listed.registry ?? "https://registry.npmjs.org/", scopes };
}

function copyProject(root, dest) {
  fs.cpSync(root, dest, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return !(name === "node_modules" || name === ".git" || name === STATE_DIR);
    },
  });
}

async function lock() {
  const root = process.cwd();
  const lockYaml = path.join(root, "pnpm-lock.yaml");
  if (!fs.existsSync(lockYaml)) {
    fail(`${root} has no pnpm-lock.yaml; run \`pnpm install\` first, which writes it`);
  }
  // pnpm fetches git dependencies and dependencies given by tarball URL
  // itself, outside the registry, so the local registry cannot lock them.
  const outside = fs
    .readFileSync(lockYaml, "utf8")
    .split("\n")
    .filter((l) => /resolution: \{.*\b(tarball|repo|type: git)\b/.test(l));
  if (outside.length > 0) {
    fail(
      `pnpm-lock.yaml has dependencies that pnpm fetches outside the registry, which this version cannot lock:\n` +
        outside.map((l) => "  " + l.trim()).join("\n"),
    );
  }
  const pnpm = pnpmCommand(root);
  const pnpmVersion = capture(pnpm, ["--version"]).trim();
  const registries = projectRegistries(root);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-purifier-lock-"));
  const project = path.join(work, "project");
  copyProject(root, project);

  const artifacts = new Map();
  const unlocked = new Set();
  const { server, base } = await startRegistry({
    record: async (relPath) => {
      const url = urlOfPath(relPath);
      if (url == null) return { status: 404 };
      const res = await fetch(url);
      const contentType = res.headers.get("content-type");
      const body = Buffer.from(await res.arrayBuffer());
      if (res.ok) {
        if (isMetadata(contentType)) unlocked.add(url);
        else artifacts.set(relPath, { path: relPath, url, hash: sri(body), ...platformFilters(body) });
      }
      return { status: res.status, contentType, body };
    },
  });

  const isolated = isolatedEnv(work);
  pinProjectRegistries(project, base, registries);
  const env = {
    ...process.env,
    ...isolated,
    ...pnpmConfigEnv(base, registries, work),
  };
  const archArgs = [
    ...LOCK_PLATFORMS.os.map((o) => `--os=${o}`),
    ...LOCK_PLATFORMS.cpu.map((c) => `--cpu=${c}`),
    ...LOCK_PLATFORMS.libc.map((l) => `--libc=${l}`),
  ];
  console.error(`pnpm-purifier: installing from pnpm-lock.yaml with pnpm ${pnpmVersion}, recording every download`);
  const code = await run(
    pnpm,
    ["install", "--frozen-lockfile", "--store-dir", path.join(work, "store"), ...archArgs],
    { cwd: project, env },
  );
  if (code !== 0) {
    server.close();
    fail(`pnpm install failed in the lock run (exit ${code}); the lock run's copy of the project is at ${project}`);
  }

  const listed = JSON.parse(capture(pnpm, ["ls", "-r", "--depth", "-1", "--json"], { cwd: project, env }));
  server.close();

  const projects = listed
    .filter((p) => p.name)
    .map((p) => ({ name: p.name, path: path.relative(project, p.path) || "." }))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const url of unlocked) {
    console.error(`pnpm-purifier: not locked, registry metadata changes over time: ${url}`);
  }

  const lockfile = {
    version: LOCK_VERSION,
    pnpmVersion,
    nodeVersion: process.versions.node,
    registries,
    // The lock holds the downloads of this pnpm-lock.yaml; when the hash no
    // longer matches, the lock is stale.
    pnpmLockHash: hexDigest(fs.readFileSync(lockYaml)),
    platforms: LOCK_PLATFORMS,
    projects,
    artifacts: [...artifacts.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  fs.writeFileSync(path.join(root, LOCK_FILE), JSON.stringify(lockfile, null, 2) + "\n");
  fs.rmSync(work, { recursive: true, force: true });
  console.error(`pnpm-purifier: wrote ${LOCK_FILE} with ${lockfile.artifacts.length} files and ${projects.length} projects`);
}

// Serves the files of a manifest (a JSON object from lockfile path to file)
// and runs `command` with pnpm configured to read through the server.
// With `projectDir`, the registry lines also go into the .npmrc of that
// directory, which must be a copy the purifier owns.
async function execWithManifest(manifestFile, lockFile, command, projectDir = null) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const lockfile = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  const { server, base } = await startRegistry({ lookup: (p) => manifest[p] ?? null });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-purifier-"));
  if (projectDir != null) pinProjectRegistries(projectDir, base, lockfile.registries);
  const env = {
    ...process.env,
    ...pnpmConfigEnv(base, lockfile.registries, configDir),
    // pnpm 12 verifies pnpm-lock.yaml against its supply-chain policies with
    // registry metadata and attestations, which change over time and so
    // are never locked. The lock run verified this pnpm-lock.yaml online
    // (readLock and the Nix build hold the lock to its hash).
    pnpm_config_trust_lockfile: "true",
  };
  const code = await run(command[0], command.slice(1), { env });
  server.close();
  fs.rmSync(configDir, { recursive: true, force: true });
  return code;
}

function readLock(root) {
  const file = path.join(root, LOCK_FILE);
  if (!fs.existsSync(file)) return null;
  const lockfile = JSON.parse(fs.readFileSync(file, "utf8"));
  if (lockfile.version !== LOCK_VERSION) {
    console.error(`pnpm-purifier: ${LOCK_FILE} has format ${lockfile.version}, and this version reads ${LOCK_VERSION}; run \`pnpm-purifier lock\``);
    return null;
  }
  const yaml = path.join(root, "pnpm-lock.yaml");
  if (!fs.existsSync(yaml) || hexDigest(fs.readFileSync(yaml)) !== lockfile.pnpmLockHash) {
    console.error(`pnpm-purifier: pnpm-lock.yaml changed since ${LOCK_FILE} was written; pnpm runs online until \`pnpm-purifier lock\``);
    return null;
  }
  return file;
}

// Builds the manifest of the locked files through Nix, with a GC root in
// .pnpm-purifier/, and returns its path.
function realize(root, lockFile) {
  const libDir = process.env.PNPM_PURIFIER_NIX_LIB ?? path.join(path.dirname(selfPath), "../nix/lib");
  const stateDir = path.join(root, STATE_DIR);
  fs.mkdirSync(stateDir, { recursive: true });
  const expr = `(import ${JSON.stringify(path.join(libDir, "realize.nix"))} { lockFile = ${JSON.stringify(lockFile)}; })`;
  capture("nix", ["build", "--impure", "--no-link", "--expr", `${expr}.fetches`], { stdio: ["ignore", "pipe", "inherit"] });
  const manifest = capture("nix", ["build", "--impure", "--print-out-paths", "--out-link", path.join(stateDir, "manifest"), "--expr", `${expr}.manifest`]).trim();
  return manifest;
}

async function interactive(args) {
  const root = process.cwd();
  const pnpm = pnpmCommand(root);
  const lockFile = process.env.PNPM_PURIFIER === "0" ? null : readLock(root);
  if (lockFile == null) {
    process.exit(await run(pnpm, args, {}));
  }
  const manifest = realize(root, lockFile);
  process.exit(await execWithManifest(manifest, lockFile, [pnpm, ...args]));
}

function parseExec(args) {
  let manifest = null;
  let lockFile = null;
  let projectDir = null;
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === "--manifest") manifest = args[++i];
    else if (args[i] === "--lock") lockFile = args[++i];
    else if (args[i] === "--pin-project") projectDir = args[++i];
    else if (args[i] === "--") break;
    else fail(`exec: unknown option ${args[i]}`);
  }
  const command = args.slice(i + 1);
  if (manifest == null || lockFile == null || command.length === 0) {
    fail("usage: pnpm-purifier exec --manifest FILE --lock FILE [--pin-project DIR] -- COMMAND...");
  }
  return { manifest, lockFile, projectDir, command };
}

// Node's fetch reads the proxy variables only with NODE_USE_ENV_PROXY set,
// and only when the process starts.
function proxyRestart() {
  const proxied = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((v) => process.env[v]);
  if (!proxied || process.env.NODE_USE_ENV_PROXY === "1") return false;
  const r = spawnSync(process.execPath, [selfPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
  });
  process.exit(r.status ?? 1);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "lock") {
  proxyRestart();
  await lock();
} else if (command === "exec") {
  const { manifest, lockFile, projectDir, command: cmd } = parseExec(rest);
  process.exit(await execWithManifest(manifest, lockFile, cmd, projectDir));
} else {
  await interactive(process.argv.slice(2));
}
