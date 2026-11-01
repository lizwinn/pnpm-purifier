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
//   pnpm-purifier --online [PNPM ARGS...]
//                                    runs pnpm with the network, and locks
//                                    again when pnpm-lock.yaml changes
//   pnpm-purifier [PNPM ARGS...]     runs pnpm on the locked downloads,
//                                    realized through Nix, offline; a command
//                                    that resolves versions (add, update,
//                                    remove, ...) runs as with --online, and
//                                    one that installs nothing (run, test,
//                                    exec, ...) runs pnpm as it is
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
//
// The parsing and the path rules are in lib.mjs.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  LOCK_FILE,
  LOCK_PLATFORMS,
  LOCK_VERSION,
  isMetadata,
  isMetadataPath,
  isResolving,
  localRegistry,
  localizeMetadata,
  lockImporters,
  lockProblems,
  needsRegistry,
  outsideResolutions,
  platformFilters,
  registryCredentials,
  registryLines,
  restoreLockText,
  rewriteLockText,
  trimPackument,
  urlOfPath,
} from "./lib.mjs";

const STATE_DIR = ".pnpm-purifier";

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

// --- pnpm-lock.yaml ---------------------------------------------------------

// Rewrites the pnpm-lock.yaml of `dir` to name the registry at `base` (see
// rewriteLockText). `fileOf(path)` names the file the registry serves for a
// git dependency.
function rewriteLockFile(dir, base, fileOf) {
  const file = path.join(dir, "pnpm-lock.yaml");
  const integrityOf = (p) => {
    const served = fileOf(p);
    return served == null ? null : "sha512-" + createHash("sha512").update(fs.readFileSync(served)).digest("base64");
  };
  let rewritten;
  try {
    rewritten = rewriteLockText(fs.readFileSync(file, "utf8"), base, integrityOf);
  } catch (err) {
    fail(err.message);
  }
  if (rewritten.pairs.length > 0) fs.writeFileSync(file, rewritten.text);
  return { file, pairs: rewritten.pairs };
}

function restoreLockFile({ file, pairs }) {
  if (pairs.length === 0 || !fs.existsSync(file)) return;
  fs.writeFileSync(file, restoreLockText(fs.readFileSync(file, "utf8"), pairs));
}

// --- Registry configuration -------------------------------------------------

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

// Starts the local registry. `lookup(relPath)` returns a file path or a
// Buffer to serve, or null; `record(relPath, accept)`, when given, answers
// the paths that `lookup` does not know, by fetching them upstream with the
// Accept header pnpm sent. It serves registry metadata (an inline entry),
// which is JSON and so starts with "{", as JSON; a tarball starts with
// gzip's magic bytes. Each path it cannot serve goes into `misses`, and with
// `quiet` it reports none of them itself.
function startRegistry({ lookup, record = null, misses = new Set(), quiet = false }) {
  let base = null;
  const server = http.createServer(async (req, res) => {
    const relPath = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const found = lookup(relPath);
      if (found == null && record) {
        const { status, contentType, body } = await record(relPath, req.headers.accept);
        let served = body;
        if (status === 200 && isMetadata(contentType)) {
          try {
            served = Buffer.from(localizeMetadata(body.toString("utf8"), base));
          } catch {
            served = body;
          }
        }
        res.writeHead(status, { "content-type": contentType ?? "application/octet-stream" });
        res.end(req.method === "HEAD" ? undefined : served);
        return;
      }
      if (found == null) {
        misses.add(relPath);
        if (!quiet) {
          const url = urlOfPath(relPath) ?? relPath;
          console.error(
            isMetadataPath(relPath)
              ? `pnpm-purifier: pnpm asked for the registry metadata of ${url}, which ${LOCK_FILE} does not hold`
              : `pnpm-purifier: ${url} is not in ${LOCK_FILE}; run \`pnpm-purifier lock\``,
          );
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `not locked: ${relPath}` }));
        return;
      }
      const data = Buffer.isBuffer(found) ? found : fs.readFileSync(found);
      if (data[0] === 0x7b) {
        const body = Buffer.from(localizeMetadata(data.toString("utf8"), base));
        res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (err) {
      console.error(`pnpm-purifier: ${relPath}: ${err.message}`);
      res.writeHead(502).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}/`;
      resolve({ server, base });
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

// The purifier library, `lib.purifier` of the flake github:nix-purifiers/purifier.
// The flake's package sets PNPM_PURIFIER_LIBRARY to the source of the
// revision it pins.
function libraryExpr() {
  const p = process.env.PNPM_PURIFIER_LIBRARY;
  const ref = p ? `path:${p}` : "github:nix-purifiers/purifier";
  return `(builtins.getFlake ${JSON.stringify(ref)}).lib.purifier`;
}

// Runs `nix build` and returns the output path; `hint`, when given, follows
// Nix's own error.
function nixBuild(expr, extraArgs = [], hint = null) {
  const r = spawnSync("nix", ["build", "--impure", "--print-out-paths", ...extraArgs, "--expr", expr], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (r.error) fail(`cannot run nix: ${r.error.message}`);
  if (r.status !== 0) fail(`the Nix build failed (exit ${r.status})${hint ? `. ${hint}` : ""}`);
  return r.stdout.trim();
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
    // pnpm prepares a git dependency without a `packageManager` field with
    // npm, which keeps its own cache.
    npm_config_cache: path.join(dir, "home/.npm"),
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

// The credentials of the user config and the project .npmrc, which the
// recorder sends upstream.
function projectCredentials(root) {
  const files = [process.env.npm_config_userconfig ?? path.join(os.homedir(), ".npmrc"), path.join(root, ".npmrc")];
  return registryCredentials(
    files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8")),
    process.env,
  );
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
    git: { url: repo, rev: commit, submodules: false, leaveDotGit: false, commitObject: null },
    hash,
  };
  // The tarball dependencies.nix makes of the entry: the library fetches
  // the checkout, and git-tarball.nix packs it.
  const expr =
    `let pkgs = ${nixpkgsExpr()}; purifier = ${libraryExpr()}; ` +
    `entry = builtins.fromJSON ${JSON.stringify(JSON.stringify(entry))}; in ` +
    `pkgs.callPackage ${JSON.stringify(path.join(libDir, "git-tarball.nix"))} { } ` +
    `{ name = "${commit}-package.tgz"; checkout = purifier.fetchEntry { inherit pkgs; } entry; ` +
    `subdirectory = ${subdirectory ? JSON.stringify(subdirectory) : "null"}; }`;
  return { entry, subdirectory: subdirectory ?? null, file: nixBuild(expr, ["--no-link"]) };
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

async function lock(root = process.cwd()) {
  const started = Date.now();
  const lockYaml = path.join(root, "pnpm-lock.yaml");
  if (!fs.existsSync(lockYaml)) {
    fail(`${root} has no pnpm-lock.yaml; run \`pnpm install\` first, which writes it`);
  }
  const pnpm = pnpmCommand(root);
  const pnpmVersion = capture(pnpm, ["--version"]).trim();
  const registries = projectRegistries(root);

  const gitFiles = new Map();
  const gitEntries = [];
  const gitSubdirectories = {};
  for (const r of outsideResolutions(fs.readFileSync(lockYaml, "utf8"))) {
    if (r.kind !== "git" || gitFiles.has(r.path)) continue;
    const { entry, subdirectory, file } = lockGit(r);
    gitFiles.set(r.path, file);
    gitEntries.push(entry);
    if (subdirectory != null) gitSubdirectories[r.path] = subdirectory;
  }

  // Pass 1 installs through the upstream registries and records every
  // tarball pnpm downloads, and the registry metadata it reads.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-purifier-lock-"));
  const recordDir = path.join(work, "record");
  const project = path.join(recordDir, "project");
  copyProject(root, project);
  const recorded = new Map();
  const files = new Map();
  const metadata = new Map();
  const credentialsFor = projectCredentials(root);
  const recorder = await startRegistry({
    lookup: (p) => gitFiles.get(p) ?? null,
    record: async (relPath, accept) => {
      const url = urlOfPath(relPath);
      if (url == null) return { status: 404 };
      const res = await fetch(url, { headers: { ...credentialsFor(url), ...(accept ? { accept } : {}) } });
      const contentType = res.headers.get("content-type");
      const body = Buffer.from(await res.arrayBuffer());
      if (res.ok) {
        if (isMetadata(contentType)) metadata.set(relPath, body);
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
  recorder.server.close();
  if (first.code !== 0) {
    fail(`pnpm install failed in the lock run (exit ${first.code}); the lock run's copy of the project is at ${project}`);
  }

  // Pass 2 installs a fresh copy from what pass 1 recorded alone, as the
  // Nix build does, which shows that the lock holds every download. pnpm
  // reads registry metadata offline only to resolve what pnpm-lock.yaml
  // does not list, such as the devDependencies of a git dependency it
  // prepares. Each metadata request of a failed pass becomes an inline
  // entry, trimmed to the recorded versions, and the pass runs again.
  const inline = new Map();
  for (let attempt = 1; ; attempt++) {
    const verifyDir = path.join(work, `verify-${attempt}`);
    const verifyProject = path.join(verifyDir, "project");
    copyProject(root, verifyProject);
    const misses = new Set();
    const verifier = await startRegistry({
      lookup: (p) => files.get(p) ?? gitFiles.get(p) ?? inline.get(p) ?? null,
      misses,
      quiet: true,
    });
    console.error("pnpm-purifier: installing again from the recorded downloads alone");
    const second = await installFrom(verifyProject, verifyDir, registries, verifier, gitFiles, OFFLINE_ENV);
    verifier.server.close();
    if (second.code === 0) break;
    const added = [];
    for (const relPath of misses) {
      const body = metadata.get(relPath);
      const trimmed = body && !inline.has(relPath) ? trimPackument(body, new Set(files.keys())) : null;
      if (trimmed != null) {
        inline.set(relPath, Buffer.from(trimmed));
        added.push(urlOfPath(relPath) ?? relPath);
      }
    }
    if (added.length === 0) {
      const missing = [...misses].map((p) => urlOfPath(p) ?? p);
      fail(
        `the install from the recorded downloads failed (exit ${second.code})` +
          (missing.length > 0 ? `; pnpm requested files that the lock run could not lock:\n  ${missing.join("\n  ")}` : "") +
          `\nThe lock run's copies of the project are in ${work}`,
      );
    }
    console.error(`pnpm-purifier: locking the registry metadata pnpm read offline:\n  ${added.join("\n  ")}`);
  }

  const projects = lockImporters(fs.readFileSync(lockYaml, "utf8"))
    .map((dir) => {
      const manifest = path.join(root, dir, "package.json");
      const name = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).name : null;
      return name ? { name, path: dir } : null;
    })
    .filter((p) => p != null)
    .sort((a, b) => a.path.localeCompare(b.path));

  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const inlineEntries = [...inline].map(([p, body]) => ({ path: p, contents: body.toString("utf8") }));
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
    // For a git dependency that names a directory of its repository
    // (`#path:` in pnpm), that directory, by the path of its git entry.
    gitSubdirectories,
    artifacts: [...recorded.values(), ...gitEntries, ...inlineEntries].sort(byPath),
  };
  fs.writeFileSync(path.join(root, LOCK_FILE), JSON.stringify(lockfile, null, 2) + "\n");
  fs.rmSync(work, { recursive: true, force: true });
  const seconds = Math.round((Date.now() - started) / 1000);
  console.error(`pnpm-purifier: wrote ${LOCK_FILE} with ${lockfile.artifacts.length} files and ${projects.length} projects in ${seconds} s`);
}

// --- Offline modes ----------------------------------------------------------

// Serves the files of a manifest (a JSON object from lockfile path to file)
// and runs `command` with pnpm configured to read through the server. With
// `projectDir`, the registry lines also go into the .npmrc of that
// directory, which must be a copy the purifier owns. The pnpm-lock.yaml of
// `projectDir`, or of `inPlace`, is rewritten for the length of the
// command. Both files are put back afterwards. The result is the exit code
// and the paths the registry could not serve.
async function execWithManifest(manifestFile, lockFile, command, { projectDir = null, inPlace = null } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const lockfile = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  const misses = new Set();
  const { server, base } = await startRegistry({ lookup: (p) => manifest[p] ?? null, misses });
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
    const code = await run(command[0], command.slice(1), { env });
    return { code, misses };
  } finally {
    restore();
    server.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

// The lockfile of `root`, when it is current, or null, after saying why
// pnpm runs online. A malformed lockfile stops the program.
function readLock(root) {
  const file = path.join(root, LOCK_FILE);
  if (!fs.existsSync(file)) return null;
  let lockfile;
  try {
    lockfile = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(`${LOCK_FILE} is not valid JSON (${err.message}); run \`pnpm-purifier lock\` to write it again`);
  }
  const problems = lockProblems(lockfile);
  if (problems.length > 0) {
    fail(`${LOCK_FILE} is not a lockfile this version reads: ${problems.slice(0, 5).join("; ")}; run \`pnpm-purifier lock\` to write it again`);
  }
  const yaml = path.join(root, "pnpm-lock.yaml");
  if (!fs.existsSync(yaml) || hexDigest(fs.readFileSync(yaml)) !== lockfile.pnpmLockHash) {
    console.error(`pnpm-purifier: pnpm-lock.yaml changed since ${LOCK_FILE} was written, so pnpm runs online; run \`pnpm-purifier lock\` to lock it again`);
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
    `{ lockFile = ${JSON.stringify(lockFile)}; purifier = ${libraryExpr()}; }`;
  return nixBuild(
    expr,
    ["--out-link", path.join(stateDir, "manifest")],
    `Nix could not fetch the files ${LOCK_FILE} names. A hash mismatch means the file was edited or a download changed; run \`pnpm-purifier lock\` to write it again`,
  );
}

// Runs pnpm with the network, and locks again when the command changed
// pnpm-lock.yaml.
async function online(root, args) {
  const yaml = path.join(root, "pnpm-lock.yaml");
  const before = fs.existsSync(yaml) ? hexDigest(fs.readFileSync(yaml)) : null;
  const code = await run(pnpmCommand(root), args, {});
  const after = fs.existsSync(yaml) ? hexDigest(fs.readFileSync(yaml)) : null;
  if (code === 0 && after != null && after !== before && process.env.PNPM_PURIFIER !== "0") {
    console.error(`pnpm-purifier: pnpm-lock.yaml changed, so ${LOCK_FILE} is written again`);
    await lock(root);
  }
  return code;
}

async function interactive(args) {
  const root = process.cwd();
  if (args[0] === "--online") process.exit(await online(root, args.slice(1)));
  if (isResolving(args)) {
    console.error(`pnpm-purifier: \`pnpm ${args.join(" ")}\` resolves versions from registry metadata, so it runs online`);
    process.exit(await online(root, args));
  }
  if (!needsRegistry(args)) process.exit(await run(pnpmCommand(root), args, {}));
  const lockFile = process.env.PNPM_PURIFIER === "0" ? null : readLock(root);
  if (lockFile == null) process.exit(await run(pnpmCommand(root), args, {}));
  const manifest = realize(root, lockFile);
  const { code, misses } = await execWithManifest(manifest, lockFile, [pnpmCommand(root), ...args], { inPlace: root });
  if (code !== 0 && [...misses].some(isMetadataPath)) {
    console.error(
      "pnpm-purifier: pnpm asked for registry metadata, which it reads only to resolve versions, " +
        "for example after package.json changed. Run the command with the network: " +
        `\`pnpm-purifier --online ${args.join(" ")}\`, which also locks again.`,
    );
  }
  process.exit(code);
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
    `build = pkgs.callPackage ${JSON.stringify(path.join(libDir, "build-pnpm-project.nix"))} { purifier = ${libraryExpr()}; }; in ` +
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
if (command === "exec") {
  const { manifest, lockFile, projectDir, command: cmd } = parseExec(rest);
  const { code, misses } = await execWithManifest(manifest, lockFile, cmd, { projectDir });
  if (code !== 0 && misses.size > 0) {
    console.error(`pnpm-purifier: the build requested files that ${LOCK_FILE} does not hold; run \`pnpm-purifier lock\``);
  }
  process.exit(code);
}
proxyRestart();
if (command === "lock") await lock();
else if (command === "publish") await publish(rest[0], rest.slice(1));
else await interactive(process.argv.slice(2));
