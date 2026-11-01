#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// pnpm-purifier: the lock run, and the local registry that pnpm reads
// through in every mode.
//
//   pnpm-purifier lock               runs the lock run in the current
//                                    directory and writes pnpm-purifier.lock.json
//   pnpm-purifier publish NAME [ARGS...]
//                                    builds the tarball of workspace project
//                                    NAME with Nix and runs `pnpm publish` on
//                                    it, with ARGS
//   pnpm-purifier exec --manifest M --lock L [--pin-project DIR] -- CMD...
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
//
// pnpm reads registry packages through the registry it is configured with.
// It fetches a dependency given by tarball URL, and a git-hosted one, from
// the absolute URL in pnpm-lock.yaml, and clones a git dependency with git.
// For those, pnpm-lock.yaml is rewritten to name the local registry while
// pnpm runs: in a copy of the project that the purifier owns (the lock run
// and the Nix build), and in place for the length of an interactive
// command.

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
const PLATFORM_ARGS = [
  ...LOCK_PLATFORMS.os.map((o) => `--os=${o}`),
  ...LOCK_PLATFORMS.cpu.map((c) => `--cpu=${c}`),
  ...LOCK_PLATFORMS.libc.map((l) => `--libc=${l}`),
];

const selfPath = fileURLToPath(import.meta.url);
const libDir = process.env.PNPM_PURIFIER_NIX_LIB ?? path.join(path.dirname(selfPath), "../nix/lib");

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
// it with "%3A"), then the URL path, as in https/registry.npmjs.org/ms/...
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

// The lockfile path of a git dependency: git/, the host and repository
// path, then the commit (and the subdirectory, when it names one).
function pathOfGit(repo, commit, subdirectory) {
  const u = new URL(repo.replace(/^git\+/, ""));
  const repoPath = u.pathname.replace(/\.git$/, "");
  const sub = subdirectory ? `/${subdirectory.replace(/^\/+|\/+$/g, "")}` : "";
  return `git/${u.hostname}${repoPath}/${commit}${sub}/package.tgz`;
}

// The registry URL pnpm uses for an upstream registry, on a server at
// `base` (http://127.0.0.1:PORT/).
function localRegistry(base, upstream) {
  const p = pathOfUrl(upstream);
  return base + (p.endsWith("/") ? p : p + "/");
}

// --- pnpm-lock.yaml ---------------------------------------------------------

// pnpm writes each resolution as a one-line YAML flow mapping, such as
//   resolution: {integrity: sha512-..., tarball: https://...}
// Its values hold no ", " followed by a key.
function parseFlowMap(text) {
  return text.split(/,\s+(?=[A-Za-z]+:\s)/).map((item) => {
    const i = item.indexOf(":");
    return [item.slice(0, i).trim(), item.slice(i + 1).trim()];
  });
}

function formatFlowMap(pairs) {
  return "{" + pairs.map(([k, v]) => `${k}: ${v}`).join(", ") + "}";
}

// The resolutions of pnpm-lock.yaml that pnpm fetches without the registry:
// tarballs by URL (git-hosted ones included) and git repositories.
function outsideResolutions(lockText) {
  const found = [];
  for (const line of lockText.split("\n")) {
    const m = line.match(/^(\s+resolution:\s)\{(.*)\}\s*$/);
    if (!m) continue;
    const map = Object.fromEntries(parseFlowMap(m[2]));
    if (map.tarball && /^https?:\/\//.test(map.tarball)) {
      found.push({ line, prefix: m[1], map, kind: "url", path: pathOfUrl(map.tarball) });
    } else if (map.type === "git" && map.commit && map.repo) {
      found.push({ line, prefix: m[1], map, kind: "git", path: pathOfGit(map.repo, map.commit, map.path) });
    }
  }
  return found;
}

// pnpm-lock.yaml with its outside resolutions pointed at the registry at
// `base`. A tarball keeps its integrity. A git repository becomes the
// tarball git-tarball.nix packs, marked `gitHosted` so that pnpm prepares it
// as it prepares a cloned repository. pnpm requires an integrity for every
// tarball, and `fileOf(path)` names the file the registry serves for the
// git dependency, whose integrity the rewritten entry carries.
function rewriteLockText(lockText, base, fileOf) {
  const pairs = [];
  for (const r of outsideResolutions(lockText)) {
    const local = base + r.path;
    let map;
    if (r.kind === "url") {
      map = Object.entries(r.map).map(([k, v]) => [k, k === "tarball" ? local : v]);
    } else {
      const file = fileOf(r.path);
      if (file == null) fail(`the git dependency ${r.map.repo} at ${r.map.commit} is not in ${LOCK_FILE}; run \`pnpm-purifier lock\``);
      const integrity = "sha512-" + createHash("sha512").update(fs.readFileSync(file)).digest("base64");
      map = [
        ["gitHosted", "true"],
        ["integrity", integrity],
        ["tarball", local],
      ];
    }
    pairs.push([r.line, r.prefix + formatFlowMap(map)]);
  }
  let text = lockText;
  for (const [from, to] of pairs) text = text.split(from).join(to);
  return { text, pairs };
}

// The workspace projects: the importers of the project document of
// pnpm-lock.yaml. pnpm 12 writes a document for its own version first, so
// the project document is the last one. Each importer key is a project
// directory relative to the lockfile, quoted when YAML needs it, and an
// importer without dependencies is an empty mapping (`.: {}`).
function lockImporters(lockText) {
  const start = lockText.lastIndexOf("\nimporters:\n");
  if (start < 0) return ["."];
  const dirs = [];
  for (const line of lockText.slice(start + "\nimporters:\n".length).split("\n")) {
    if (line !== "" && !line.startsWith(" ")) break;
    const m = line.match(/^ {2}(\S.*?):(?: \{\})?$/);
    if (m) dirs.push(m[1].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return dirs;
}

function rewriteLockFile(dir, base, fileOf) {
  const file = path.join(dir, "pnpm-lock.yaml");
  const original = fs.readFileSync(file, "utf8");
  const { text, pairs } = rewriteLockText(original, base, fileOf);
  if (pairs.length > 0) fs.writeFileSync(file, text);
  return { file, pairs };
}

// Puts the original resolutions back, also into a pnpm-lock.yaml that pnpm
// rewrote meanwhile.
function restoreLockFile({ file, pairs }) {
  if (pairs.length === 0 || !fs.existsSync(file)) return;
  let text = fs.readFileSync(file, "utf8");
  for (const [from, to] of pairs) text = text.split(to).join(from);
  fs.writeFileSync(file, text);
}

// --- Registry configuration -------------------------------------------------

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

// pnpm 12 verifies pnpm-lock.yaml against its supply-chain policies with
// registry metadata and attestations, which change over time and so are
// never locked. The lock run verified this pnpm-lock.yaml online, and every
// offline mode holds the lock to its hash.
const OFFLINE_ENV = { pnpm_config_trust_lockfile: "true" };

// A project .npmrc takes precedence over the user config, so in a copy of
// the project that the purifier owns the registry lines go there too. The
// result puts the file back as it was.
function pinProjectRegistries(projectDir, base, registries) {
  const rc = path.join(projectDir, ".npmrc");
  if (!fs.existsSync(rc)) return () => {};
  const original = fs.readFileSync(rc);
  fs.appendFileSync(rc, "\n" + registryLines(base, registries));
  return () => fs.writeFileSync(rc, original);
}

// --- The local registry -----------------------------------------------------

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

// Starts the local registry. `lookup(relPath)` returns a file path or a
// Buffer to serve, or null; `record(relPath)`, when given, answers the
// paths that `lookup` does not know, by fetching them upstream.
function startRegistry({ lookup, record = null, misses = new Set() }) {
  const server = http.createServer(async (req, res) => {
    const relPath = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const found = lookup(relPath);
      if (found == null && record) {
        const { status, contentType, body } = await record(relPath);
        res.writeHead(status, { "content-type": contentType ?? "application/octet-stream" });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      if (found == null) {
        const url = urlOfPath(relPath) ?? relPath;
        misses.add(url);
        console.error(`pnpm-purifier: ${url} is not in ${LOCK_FILE}; run \`pnpm-purifier lock\``);
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `not locked: ${url}` }));
        return;
      }
      const size = Buffer.isBuffer(found) ? found.length : fs.statSync(found).size;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size });
      if (req.method === "HEAD") res.end();
      else if (Buffer.isBuffer(found)) res.end(found);
      else fs.createReadStream(found).pipe(res);
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

// --- Processes --------------------------------------------------------------

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", (err) => fail(`cannot run ${command}: ${err.message}`));
    child.on("exit", (code, signal) => resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : code));
  });
}

function capture(command, args, options) {
  const r = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.error) fail(`cannot run ${command}: ${r.error.message}`);
  if (r.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${r.stderr ?? ""}`);
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

// The nixpkgs the Nix builds of this program use. The flake's package sets
// PNPM_PURIFIER_NIXPKGS to the nixpkgs it pins.
function nixpkgsExpr() {
  const p = process.env.PNPM_PURIFIER_NIXPKGS;
  return p ? `(import ${JSON.stringify(p)} { })` : `(import <nixpkgs> { })`;
}

function nixBuild(expr, extraArgs = []) {
  return capture("nix", ["build", "--impure", "--print-out-paths", ...extraArgs, "--expr", expr], {
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
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

// --- The lock run -----------------------------------------------------------

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

// The registry credentials of the user config and the project .npmrc, as
// pnpm reads them: `//host/path/:_authToken=TOKEN` (a bearer token) and
// `//host/path/:_auth=BASE64` (basic authentication), with ${VAR} taken
// from the environment. The recorder sends a request upstream with the
// credential of the longest prefix that matches its URL.
function registryCredentials(root) {
  const files = [process.env.npm_config_userconfig ?? path.join(os.homedir(), ".npmrc"), path.join(root, ".npmrc")];
  const credentials = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*\/\/(.+):(_authToken|_auth)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const value = m[3].replace(/^(['"])(.*)\1$/, "$2").replace(/\$\{([^}]+)\}/g, (_, v) => process.env[v] ?? "");
      credentials.push({
        prefix: "//" + m[1],
        header: m[2] === "_authToken" ? `Bearer ${value}` : `Basic ${value}`,
      });
    }
  }
  return (url) => {
    const target = url.replace(/^https?:/, "");
    const match = credentials
      .filter((c) => target.startsWith(c.prefix.endsWith("/") ? c.prefix : c.prefix + "/"))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    return match ? { authorization: match.header } : {};
  };
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

// Locks a git dependency of pnpm-lock.yaml: its checkout hash, from
// nix-prefetch-git, and the tarball git-tarball.nix packs from it, which the
// lock run serves.
function lockGit(resolution) {
  const { repo, commit, path: subdirectory } = resolution.map;
  console.error(`pnpm-purifier: fetching ${repo} at ${commit}`);
  const prefetched = JSON.parse(capture("nix-prefetch-git", ["--url", repo, "--rev", commit, "--quiet"]));
  const hash = prefetched.hash;
  if (!hash) fail(`nix-prefetch-git reported no hash for ${repo}`);
  const entry = {
    path: resolution.path,
    // pnpm installs the files of the commit, not a repository, so the
    // checkout keeps no .git.
    git: { url: repo, rev: commit, submodules: false, leaveDotGit: false },
    hash,
    ...(subdirectory ? { subdirectory } : {}),
  };
  // The same derivation as the git entry's in dependencies.nix, named as
  // lock.nix's artifactName names it.
  const lockNix = `(import ${JSON.stringify(path.join(libDir, "lock.nix"))} { lockFile = builtins.toFile "lock.json" (builtins.toJSON { version = import ${JSON.stringify(path.join(libDir, "lock-version.nix"))}; projects = [ ]; artifacts = [ ]; }); })`;
  const expr =
    `let pkgs = ${nixpkgsExpr()}; entry = builtins.fromJSON ${JSON.stringify(JSON.stringify(entry))}; in ` +
    `pkgs.callPackage ${JSON.stringify(path.join(libDir, "git-tarball.nix"))} { } ` +
    `{ name = ${lockNix}.artifactName entry; inherit (entry.git) url rev submodules leaveDotGit; ` +
    `inherit (entry) hash; subdirectory = entry.subdirectory or null; }`;
  return { entry, file: nixBuild(expr, ["--no-link"]) };
}

async function installFrom(project, work, registries, server, gitFiles, extraEnv) {
  pinProjectRegistries(project, server.base, registries);
  const rewrite = rewriteLockFile(project, server.base, (p) => gitFiles.get(p) ?? null);
  const env = {
    ...process.env,
    ...isolatedEnv(work),
    ...pnpmConfigEnv(server.base, registries, work),
    ...extraEnv,
  };
  const code = await run(
    pnpmCommand(project),
    ["install", "--frozen-lockfile", "--store-dir", path.join(work, "store"), ...PLATFORM_ARGS],
    { cwd: project, env },
  );
  return { code, env, rewrite };
}

async function lock() {
  const root = process.cwd();
  const lockYaml = path.join(root, "pnpm-lock.yaml");
  if (!fs.existsSync(lockYaml)) {
    fail(`${root} has no pnpm-lock.yaml; run \`pnpm install\` first, which writes it`);
  }
  const pnpm = pnpmCommand(root);
  const pnpmVersion = capture(pnpm, ["--version"]).trim();
  const registries = projectRegistries(root);

  const gitFiles = new Map();
  const gitEntries = [];
  for (const r of outsideResolutions(fs.readFileSync(lockYaml, "utf8"))) {
    if (r.kind !== "git" || gitFiles.has(r.path)) continue;
    const { entry, file } = lockGit(r);
    gitFiles.set(r.path, file);
    gitEntries.push(entry);
  }

  // Pass 1 installs through the upstream registries and records every
  // tarball pnpm downloads.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-purifier-lock-"));
  const recordDir = path.join(work, "record");
  const project = path.join(recordDir, "project");
  copyProject(root, project);
  const recorded = new Map();
  const files = new Map();
  const unlocked = new Set();
  const credentialsFor = registryCredentials(root);
  const recorder = await startRegistry({
    lookup: (p) => gitFiles.get(p) ?? null,
    record: async (relPath) => {
      const url = urlOfPath(relPath);
      if (url == null) return { status: 404 };
      const res = await fetch(url, { headers: credentialsFor(url) });
      const contentType = res.headers.get("content-type");
      const body = Buffer.from(await res.arrayBuffer());
      if (res.ok) {
        if (isMetadata(contentType)) unlocked.add(url);
        else {
          files.set(relPath, body);
          // pnpm names one URL per file, and the lock keeps no others.
          recorded.set(relPath, { path: relPath, url, mirrors: [], hash: sri(body), ...platformFilters(body) });
        }
      }
      return { status: res.status, contentType, body };
    },
  });
  console.error(`pnpm-purifier: installing from pnpm-lock.yaml with pnpm ${pnpmVersion}, recording every download`);
  const first = await installFrom(project, recordDir, registries, recorder, gitFiles, {});
  if (first.code !== 0) {
    recorder.server.close();
    fail(`pnpm install failed in the lock run (exit ${first.code}); the lock run's copy of the project is at ${project}`);
  }
  recorder.server.close();

  // Pass 2 installs a fresh copy from what pass 1 recorded alone, as the
  // Nix build does, which shows that the lock holds every download.
  const verifyDir = path.join(work, "verify");
  const verifyProject = path.join(verifyDir, "project");
  copyProject(root, verifyProject);
  const misses = new Set();
  const verifier = await startRegistry({ lookup: (p) => files.get(p) ?? gitFiles.get(p) ?? null, misses });
  console.error("pnpm-purifier: installing again from the recorded downloads alone");
  const second = await installFrom(verifyProject, verifyDir, registries, verifier, gitFiles, OFFLINE_ENV);
  verifier.server.close();
  if (second.code !== 0) {
    fail(
      `the install from the recorded downloads failed (exit ${second.code})` +
        (misses.size > 0 ? `; pnpm requested files that the lock run could not lock:\n  ${[...misses].join("\n  ")}` : "") +
        `\nThe lock run's copies of the project are in ${work}`,
    );
  }

  const projects = lockImporters(fs.readFileSync(lockYaml, "utf8"))
    .map((dir) => {
      const manifest = path.join(root, dir, "package.json");
      const name = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).name : null;
      return name ? { name, path: dir } : null;
    })
    .filter((p) => p != null)
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const url of unlocked) {
    console.error(`pnpm-purifier: not locked, registry metadata changes over time: ${url}`);
  }

  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
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
    artifacts: [...recorded.values(), ...gitEntries].sort(byPath),
  };
  fs.writeFileSync(path.join(root, LOCK_FILE), JSON.stringify(lockfile, null, 2) + "\n");
  fs.rmSync(work, { recursive: true, force: true });
  console.error(`pnpm-purifier: wrote ${LOCK_FILE} with ${lockfile.artifacts.length} files and ${projects.length} projects`);
}

// --- Offline modes ----------------------------------------------------------

// Serves the files of a manifest (a JSON object from lockfile path to file)
// and runs `command` with pnpm configured to read through the server. With
// `projectDir`, the registry lines also go into the .npmrc of that
// directory, which must be a copy the purifier owns. The pnpm-lock.yaml of
// `projectDir`, or of `inPlace`, is rewritten for the length of the
// command. Both files are put back afterwards.
async function execWithManifest(manifestFile, lockFile, command, { projectDir = null, inPlace = null } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const lockfile = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  const { server, base } = await startRegistry({ lookup: (p) => manifest[p] ?? null });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-purifier-"));
  const fileOf = (p) => manifest[p] ?? null;
  const unpin = projectDir != null ? pinProjectRegistries(projectDir, base, lockfile.registries) : () => {};
  const lockDir = projectDir ?? inPlace;
  const rewrite = lockDir != null ? rewriteLockFile(lockDir, base, fileOf) : null;
  const restore = () => {
    unpin();
    if (rewrite) restoreLockFile(rewrite);
  };
  const onSignal = (signal) => {
    restore();
    process.kill(process.pid, signal);
  };
  if (rewrite) for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(s, onSignal);
  const env = {
    ...process.env,
    ...pnpmConfigEnv(base, lockfile.registries, configDir),
    ...OFFLINE_ENV,
  };
  try {
    return await run(command[0], command.slice(1), { env });
  } finally {
    restore();
    server.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
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

// Builds the manifest of the locked files with Nix (dependencies.nix), with
// a GC root in .pnpm-purifier/, and returns its path.
function realize(root, lockFile) {
  const stateDir = path.join(root, STATE_DIR);
  fs.mkdirSync(stateDir, { recursive: true });
  const expr =
    `${nixpkgsExpr()}.callPackage ${JSON.stringify(path.join(libDir, "dependencies.nix"))} ` +
    `{ lockFile = ${JSON.stringify(lockFile)}; }`;
  return nixBuild(expr, ["--out-link", path.join(stateDir, "manifest")]);
}

async function interactive(args) {
  const root = process.cwd();
  const pnpm = pnpmCommand(root);
  const lockFile = process.env.PNPM_PURIFIER === "0" ? null : readLock(root);
  if (lockFile == null) {
    process.exit(await run(pnpm, args, {}));
  }
  const manifest = realize(root, lockFile);
  process.exit(await execWithManifest(manifest, lockFile, [pnpm, ...args], { inPlace: root }));
}

// --- Publishing -------------------------------------------------------------

// Builds the tarball of workspace project `name` in the Nix sandbox, as
// buildPnpmProject does for a consumer, and publishes that file with pnpm.
async function publish(name, args) {
  const root = process.cwd();
  if (!name) fail("usage: pnpm-purifier publish NAME [PNPM PUBLISH ARGUMENTS...]");
  const lockFile = readLock(root);
  if (lockFile == null) fail(`publishing needs a current ${LOCK_FILE}; run \`pnpm-purifier lock\``);
  const lockfile = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  if (!lockfile.projects.some((p) => p.name === name)) {
    fail(`${LOCK_FILE} has no project ${name}; its projects are ${lockfile.projects.map((p) => p.name).join(", ")}`);
  }
  const expr =
    `let pkgs = ${nixpkgsExpr()}; ` +
    `build = pkgs.callPackage ${JSON.stringify(path.join(libDir, "build-pnpm-project.nix"))} { }; in ` +
    `(build { src = /. + ${JSON.stringify(root)}; lockFile = /. + ${JSON.stringify(lockFile)}; })` +
    `.packages.${JSON.stringify(name)}.tarball`;
  const out = nixBuild(expr, ["--no-link"]);
  const tarballs = fs.readdirSync(out).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) fail(`${out} holds ${tarballs.length} tarballs, and publishing needs one`);
  const tarball = path.join(out, tarballs[0]);
  console.error(`pnpm-purifier: publishing ${tarball}, built by Nix`);
  process.exit(await run(pnpmCommand(root), ["publish", tarball, ...args], {}));
}

// --- Command line -----------------------------------------------------------

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
  if (!proxied || process.env.NODE_USE_ENV_PROXY === "1") return;
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
} else if (command === "publish") {
  await publish(rest[0], rest.slice(1));
} else if (command === "exec") {
  const { manifest, lockFile, projectDir, command: cmd } = parseExec(rest);
  process.exit(await execWithManifest(manifest, lockFile, cmd, { projectDir }));
} else {
  await interactive(process.argv.slice(2));
}
