// SPDX-License-Identifier: MIT
//
// The pure parts of pnpm-purifier: how a URL becomes a lockfile path, how
// pnpm-lock.yaml is read and rewritten, how registry metadata and npmrc
// credentials are read, and how a lockfile is checked. They read no files
// and start no processes, so tests/unit/ tests them directly.

import { createHash } from "node:crypto";
import zlib from "node:zlib";

export const LOCK_FILE = "pnpm-purifier.lock.json";
export const LOCK_VERSION = 2;

// The Nix systems a lock covers. pnpm installs the optional dependencies of
// every listed platform during the lock run, so the lock holds the native
// packages (such as @esbuild/linux-arm64) of each system.
export const LOCK_PLATFORMS = { os: ["linux", "darwin"], cpu: ["x64", "arm64"], libc: ["glibc"] };

// --- Paths ------------------------------------------------------------------

// The lockfile path of an upstream URL: the scheme, the host (a port joins
// it with "%3A"), then the URL path, as in https/registry.npmjs.org/ms/...
export function pathOfUrl(url) {
  const u = new URL(url);
  const scheme = u.protocol.replace(/:$/, "");
  const host = u.port ? `${u.hostname}%3A${u.port}` : u.hostname;
  return `${scheme}/${host}${u.pathname}`;
}

// The upstream URL of a lockfile path, or null for a path that names no
// URL (a git dependency's path).
export function urlOfPath(relPath) {
  const [scheme, host, ...rest] = relPath.split("/");
  if ((scheme !== "https" && scheme !== "http") || !host) return null;
  return `${scheme}://${host.replace("%3A", ":")}/${rest.join("/")}`;
}

// The lockfile path of a git dependency: git/, the host and repository
// path, then the commit (and the subdirectory, when it names one).
export function pathOfGit(repo, commit, subdirectory) {
  const u = new URL(repo.replace(/^git\+/, ""));
  const repoPath = u.pathname.replace(/\.git$/, "");
  const sub = subdirectory ? `/${subdirectory.replace(/^\/+|\/+$/g, "")}` : "";
  return `git/${u.hostname}${repoPath}/${commit}${sub}/package.tgz`;
}

// The registry URL pnpm uses for an upstream registry, on a server at
// `base` (http://127.0.0.1:PORT/).
export function localRegistry(base, upstream) {
  const p = pathOfUrl(upstream);
  return base + (p.endsWith("/") ? p : p + "/");
}

// --- pnpm-lock.yaml ---------------------------------------------------------

// pnpm writes each resolution as a one-line YAML flow mapping, such as
//   resolution: {integrity: sha512-..., tarball: https://...}
// Its values hold no ", " followed by a key.
export function parseFlowMap(text) {
  return text.split(/,\s+(?=[A-Za-z]+:\s)/).map((item) => {
    const i = item.indexOf(":");
    return [item.slice(0, i).trim(), item.slice(i + 1).trim()];
  });
}

export function formatFlowMap(pairs) {
  return "{" + pairs.map(([k, v]) => `${k}: ${v}`).join(", ") + "}";
}

// The resolutions of pnpm-lock.yaml that pnpm fetches without the registry:
// tarballs by URL (git-hosted ones included) and git repositories.
export function outsideResolutions(lockText) {
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
// tarball, and `integrityOf(path)` gives the integrity of the tarball the
// registry serves for a git dependency, or null when it serves none, which
// throws. The result also lists each rewritten line with its original.
export function rewriteLockText(lockText, base, integrityOf) {
  const pairs = [];
  for (const r of outsideResolutions(lockText)) {
    const local = base + r.path;
    let map;
    if (r.kind === "url") {
      map = Object.entries(r.map).map(([k, v]) => [k, k === "tarball" ? local : v]);
    } else {
      const integrity = integrityOf(r.path);
      if (integrity == null) {
        throw new Error(`the git dependency ${r.map.repo} at ${r.map.commit} is not in ${LOCK_FILE}; run \`pnpm-purifier lock\``);
      }
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

// pnpm-lock.yaml with the original resolutions of `pairs` put back, also
// into a file that pnpm rewrote meanwhile.
export function restoreLockText(text, pairs) {
  for (const [from, to] of pairs) text = text.split(to).join(from);
  return text;
}

// The workspace projects: the importers of the project document of
// pnpm-lock.yaml. pnpm 12 writes a document for its own version first, so
// the project document is the last one. Each importer key is a project
// directory relative to the lockfile, quoted when YAML needs it, and an
// importer without dependencies is an empty mapping (`.: {}`).
export function lockImporters(lockText) {
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

// The packages of the project document of pnpm-lock.yaml, as
// nix/lib/pnpm-lock.nix reads them: { key, name, version, resolution,
// filters }, where `resolution` maps each key of the flow mapping to its
// value and `filters` holds the `os`, `cpu` and `libc` lists that are set.
export function lockPackages(lockText) {
  const documents = lockText.split("\n---\n");
  const document = documents[documents.length - 1];
  const start = document.lastIndexOf("\npackages:\n");
  if (start < 0) return [];
  const packages = [];
  let current = null;
  for (const line of document.slice(start + "\npackages:\n".length).split("\n")) {
    if (line !== "" && !line.startsWith(" ")) break;
    const key = line.match(/^ {2}(\S.*?):(?: \{\})?$/);
    if (key) {
      const unquoted = key[1].replace(/^(['"])(.*)\1$/, "$2");
      const nv = unquoted.match(/^(@?[^@]+)@(.*)$/);
      current = { key: unquoted, name: nv ? nv[1] : unquoted, version: nv ? nv[2] : null, resolution: {}, filters: {} };
      packages.push(current);
      continue;
    }
    const f = line.match(/^ {4}(resolution|os|cpu|libc): (.*)$/);
    if (!current || !f) continue;
    if (f[1] === "resolution") {
      const inner = f[2].match(/^\{(.*)\}$/);
      if (inner) current.resolution = Object.fromEntries(parseFlowMap(inner[1]).map(([k, v]) => [k, v.replace(/^(['"])(.*)\1$/, "$2")]));
    } else {
      const inner = f[2].match(/^\[(.*)\]$/);
      current.filters[f[1]] = inner && inner[1] !== "" ? inner[1].split(", ").map((v) => v.replace(/^(['"])(.*)\1$/, "$2")) : [];
    }
  }
  return packages;
}

// The lockfile paths of the files pnpm-lock.yaml implies, as
// nix/lib/entries.nix derives them: a registry package's tarball at its
// registry, and a dependency given by tarball URL at that URL. Git
// dependencies and local files are not among them.
export function derivedFilePaths(lockText, registries) {
  const paths = new Set();
  for (const p of lockPackages(lockText)) {
    const r = p.resolution;
    if (r.directory || r.type === "git" || (r.tarball && r.tarball.startsWith("file:"))) continue;
    if (r.tarball) {
      paths.add(pathOfUrl(r.tarball));
    } else if (p.version) {
      const scope = p.name.match(/^(@[^/]+)\//);
      const registry = (scope && registries.scopes?.[scope[1]]) || registries.default;
      const base = p.name.replace(/^@[^/]+\//, "");
      paths.add(pathOfUrl(`${registry}${p.name}/-/${base}-${p.version}.tgz`));
    }
  }
  return paths;
}

// The registries a project's .npmrc sets, as nix/lib/registries.nix reads
// them: `registry=URL` and `@scope:registry=URL`, over npm's default
// registry and pnpm's default for the @jsr scope.
export function registriesFromNpmrc(npmrcText) {
  const withSlash = (url) => (url.endsWith("/") ? url : url + "/");
  const registries = { default: "https://registry.npmjs.org/", scopes: { "@jsr": "https://npm.jsr.io/" } };
  // As in an ini file, a later line wins over an earlier one.
  for (const line of npmrcText.split("\n")) {
    const scoped = line.match(/^[ \t]*(@[^:= \t]+):registry[ \t]*=[ \t]*([^ \t]+)[ \t]*$/);
    const plain = line.match(/^[ \t]*registry[ \t]*=[ \t]*([^ \t]+)[ \t]*$/);
    if (scoped) registries.scopes[scoped[1]] = withSlash(scoped[2]);
    else if (plain) registries.default = withSlash(plain[1]);
  }
  return registries;
}

// Whether the registries the project's .npmrc sets cover the registries
// pnpm resolves from: the same default, and each scope pnpm has mapped the
// same way. When they do not, the user config sets registries, and the
// lockfile records them.
export function registriesCover(derived, actual) {
  const withSlash = (url) => (url.endsWith("/") ? url : url + "/");
  if (withSlash(derived.default) !== withSlash(actual.default)) return false;
  return Object.entries(actual.scopes ?? {}).every(([scope, url]) => derived.scopes?.[scope] && withSlash(derived.scopes[scope]) === withSlash(url));
}

// --- Registry configuration -------------------------------------------------

// The .npmrc lines that point each upstream registry of the lock at its
// local mirror, and keep pnpm on the version that runs: a `packageManager`
// field naming another version otherwise makes pnpm download that one.
export function registryLines(base, registries) {
  const lines = [`registry=${localRegistry(base, registries.default)}`];
  for (const [scope, url] of Object.entries(registries.scopes ?? {})) {
    lines.push(`${scope}:registry=${localRegistry(base, url)}`);
  }
  lines.push("manage-package-manager-versions=false", "pm-on-fail=ignore", "update-notifier=false");
  return lines.join("\n") + "\n";
}

// The registry credentials of .npmrc texts, as pnpm reads them:
// `//host/path/:_authToken=TOKEN` (a bearer token) and
// `//host/path/:_auth=BASE64` (basic authentication), with ${VAR} taken
// from `env`. The result gives the headers for a URL: the credential of
// the longest prefix that matches it.
export function registryCredentials(texts, env) {
  const credentials = [];
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*\/\/(.+):(_authToken|_auth)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const value = m[3].replace(/^(['"])(.*)\1$/, "$2").replace(/\$\{([^}]+)\}/g, (_, v) => env[v] ?? "");
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

// --- Packages and metadata --------------------------------------------------

// The package.json of an npm package tarball (a gzipped tar archive with
// the package under one top-level directory), or null.
export function tarballManifest(buffer) {
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
export function platformFilters(buffer) {
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
export function isMetadata(contentType) {
  return /json/.test(contentType ?? "");
}

// Whether a lockfile path names the registry metadata of a package: a
// package name (`name` or `@scope/name`) right under the host.
export function isMetadataPath(relPath) {
  const [scheme, host, ...rest] = relPath.split("/");
  if ((scheme !== "https" && scheme !== "http") || !host) return false;
  return rest.length === 1 ? rest[0] !== "" : rest.length === 2 && rest[0].startsWith("@") && rest[1] !== "";
}

// A packument cut down to the versions whose tarballs the lock run
// recorded. pnpm reads registry metadata only to resolve a dependency that
// pnpm-lock.yaml does not list, such as a devDependency of a git
// dependency it prepares. With only the recorded versions left, resolution
// offline picks the versions it picked online. Returns null when none of
// the packument's versions was recorded, or when it is not JSON.
export function trimPackument(body, recordedPaths) {
  let doc;
  try {
    doc = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  const versions = {};
  for (const [version, manifest] of Object.entries(doc.versions ?? {})) {
    const tarball = manifest?.dist?.tarball;
    if (tarball && recordedPaths.has(pathOfUrl(tarball))) versions[version] = manifest;
  }
  if (Object.keys(versions).length === 0) return null;
  const pick = (object) => Object.fromEntries(Object.entries(object ?? {}).filter(([, v]) => versions[v] != null));
  const trimmed = { name: doc.name, "dist-tags": pick(doc["dist-tags"]), versions };
  if (doc.modified) trimmed.modified = doc.modified;
  if (doc.time) {
    trimmed.time = Object.fromEntries(Object.entries(doc.time).filter(([k]) => versions[k] != null || k === "created" || k === "modified"));
  }
  return JSON.stringify(trimmed);
}

// Registry metadata as the registry at `base` serves it. The metadata names
// each version's tarball by its upstream URL, and npm downloads from that
// URL, so the served metadata names the same tarball on the local registry.
export function localizeMetadata(text, base) {
  const doc = JSON.parse(text);
  for (const manifest of Object.values(doc.versions ?? {})) {
    if (manifest?.dist?.tarball) manifest.dist.tarball = base + pathOfUrl(manifest.dist.tarball);
  }
  return JSON.stringify(doc);
}

// --- Commands and lockfiles -------------------------------------------------

// The pnpm commands that resolve versions, which reads registry metadata
// that the lock does not hold, so interactive mode runs them online.
const RESOLVING = new Set(["add", "update", "up", "upgrade", "remove", "rm", "uninstall", "un", "dedupe", "outdated", "dlx", "create"]);

// The options of pnpm that take a value as the next argument, when the value
// is not joined with "=".
const VALUE_OPTIONS = new Set(["--filter", "-F", "--dir", "-C", "--store-dir", "--reporter", "--loglevel", "--workspace-dir", "--lockfile-dir"]);

// Whether pnpm arguments resolve versions: a resolving command, or
// `install` naming packages (`pnpm install ms` adds ms). The first argument
// that is neither an option nor an option's value is the command.
export function isResolving(args) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_OPTIONS.has(args[i])) i++;
    else if (!args[i].startsWith("-")) words.push(args[i]);
  }
  const command = words[0];
  if (command == null) return false;
  if (RESOLVING.has(command)) return true;
  return (command === "install" || command === "i") && words.length > 1;
}

// The pnpm commands that install packages from a lockfile, which therefore
// read through the local registry. `pnpm` without a command installs.
const INSTALLING = new Set(["install", "i", "ci", "fetch", "rebuild", "rb", "deploy", "import", "prune"]);

// Whether pnpm arguments install packages. Other commands (run, test,
// exec, a script name, ...) download nothing, so they run without the
// local registry.
export function needsRegistry(args) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_OPTIONS.has(args[i])) i++;
    else if (!args[i].startsWith("-")) words.push(args[i]);
  }
  return words.length === 0 || INSTALLING.has(words[0]);
}

// A value as JSON in the form Nix's builtins.toJSON writes: object keys in
// sorted order and no whitespace.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJSON(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

// The hash of a lockfile's own content: the sha256, in hexadecimal, of its
// canonical JSON without the `contentHash` field. lock.nix computes the
// same during evaluation, so an edit to the lockfile fails there too.
export function contentHash(lockfile) {
  const { contentHash: _, ...rest } = lockfile;
  return createHash("sha256").update(canonicalJSON(rest)).digest("hex");
}

// The problems of a parsed lockfile, as messages; empty when it has the
// shape this version writes.
export function lockProblems(lockfile) {
  if (lockfile == null || typeof lockfile !== "object" || Array.isArray(lockfile)) return ["it is not a JSON object"];
  if (lockfile.version !== LOCK_VERSION) return [`it has format ${lockfile.version}, and this version reads ${LOCK_VERSION}`];
  const problems = [];
  for (const key of ["pnpmLockHash", "contentHash"]) {
    if (typeof lockfile[key] !== "string") problems.push(`${key} is not a string`);
  }
  if (lockfile.pnpmVersion != null && typeof lockfile.pnpmVersion !== "string") problems.push("pnpmVersion is not a string");
  if (typeof lockfile.contentHash === "string" && lockfile.contentHash !== contentHash(lockfile)) {
    problems.push("its content does not match its contentHash, so it was edited after `pnpm-purifier lock` wrote it");
  }
  if (!Array.isArray(lockfile.artifacts)) return [...problems, "artifacts is not a list"];
  lockfile.artifacts.forEach((a, i) => {
    const where = `artifact ${i}${a?.path ? ` (${a.path})` : ""}`;
    if (typeof a?.path !== "string") problems.push(`${where} has no path`);
    else if (typeof a.contents === "string") return;
    else if (a.git != null) {
      for (const key of ["url", "rev"]) if (typeof a.git[key] !== "string") problems.push(`${where} has no git.${key}`);
      if (typeof a.hash !== "string" || !a.hash.startsWith("sha256-")) problems.push(`${where} has no sha256 hash`);
    } else {
      if (typeof a.url !== "string") problems.push(`${where} has no url`);
      if (!Array.isArray(a.mirrors)) problems.push(`${where} has no mirrors list`);
      if (typeof a.hash !== "string" || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(a.hash)) problems.push(`${where} has no sha256 hash`);
    }
  });
  return problems;
}
