# The download entries of a build, in the shape of the purifier library.
# Most come from pnpm-lock.yaml: a registry package is a file at its
# registry's tarball URL, and a dependency given by tarball URL (GitHub,
# GitLab and Bitbucket ones included) a file at that URL, each with the
# sha512 integrity pnpm recorded as its hash. The purifier lockfile
# (`lock`, or null for a project that needs none) adds what pnpm-lock.yaml
# cannot say: the checkout hash of each git dependency, and the files and
# registry metadata a git dependency's prepare step reads.
#
# An entry keeps npm's `os`, `cpu` and `libc` filters beside its fields,
# and carries `systems`, the Nix systems whose platform the filters admit
# (`admits` of the purifier library), when it has filters. A git entry for a dependency that names a directory of its
# repository (`#path:` in pnpm) carries that directory as `subdirectory`.
# src/lib.mjs derives the same paths.
#
# The result is { importers, entries, problems }, where `problems` names
# what pnpm-lock.yaml and the purifier lockfile lack, and the command that
# fixes it.
#
# Needs no nixpkgs.
{
  pnpmLockText,
  registries,
  admits,
  lock ? null,
  providedNames ? [ ],
  providedVersions ? [ ],
  # The pnpm-lock.yaml, for messages.
  pnpmLockName ? "pnpm-lock.yaml",
}:
let
  inherit (builtins)
    filter
    match
    elemAt
    concatMap
    listToAttrs
    replaceStrings
    head
    ;

  parsed = import ./pnpm-lock.nix pnpmLockText;

  # The systems a lock covers: those `admits` knows.
  lockSystems = [
    "x86_64-linux"
    "aarch64-linux"
    "aarch64-darwin"
  ];

  # The lockfile path of an upstream URL: the scheme, the host (a port
  # joins it with "%3A"), then the URL path, as in
  # https/registry.npmjs.org/ms/-/ms-2.1.3.tgz. Null for a string that is
  # not a URL.
  pathOfUrl =
    url:
    let
      m = match "([a-z]+)://([^/?#]+)([^?#]*).*" url;
    in
    if m == null then
      null
    else
      "${elemAt m 0}/${replaceStrings [ ":" ] [ "%3A" ] (elemAt m 1)}${elemAt m 2}";

  # The lockfile path of a git dependency: git/, the host and repository
  # path, then the commit and the subdirectory. Null for a repository that
  # is not a URL.
  pathOfGit =
    repo: commit: subdirectory:
    let
      m = match "(git[+])?[a-z+]+://([^@/]*@)?([^:/]+)(:[0-9]+)?(/[^?#]*).*" repo;
      withoutGit = match "(.*)[.]git" (elemAt m 4);
      repoPath = if withoutGit == null then elemAt m 4 else head withoutGit;
      sub = if subdirectory == null then "" else "/" + head (match "/*(.*[^/])/*" subdirectory);
    in
    if m == null then null else "git/${elemAt m 2}${repoPath}/${commit}${sub}/package.tgz";

  registryFor =
    name:
    let
      scope = match "(@[^/]+)/.*" name;
    in
    if scope != null && registries.scopes ? ${head scope} then
      registries.scopes.${head scope}
    else
      registries.default;

  lockArtifacts = if lock == null then [ ] else lock.artifacts;
  lockByPath = listToAttrs (
    map (a: {
      name = a.path;
      value = a;
    }) lockArtifacts
  );

  withSystems =
    filters: entry:
    if filters == { } then
      entry
    else
      entry
      // filters
      // {
        systems = filter (admits {
          os = filters.os or null;
          cpu = filters.cpu or null;
          libc = filters.libc or null;
        }) lockSystems;
      };

  ok = entry: {
    entries = [ entry ];
    problems = [ ];
  };
  problem = message: {
    entries = [ ];
    problems = [ "pnpm-purifier: ${message}" ];
  };
  file =
    url: hash: filters:
    let
      path = pathOfUrl url;
    in
    let
      entry = withSystems filters {
        inherit path url hash;
        mirrors = [ ];
      };
    in
    if path == null then
      problem "${url} in ${pnpmLockName} is not a URL"
    # A package for platforms the lock does not cover, such as a native
    # binary for Windows, is needed on no system.
    else if (entry.systems or null) == [ ] then
      {
        entries = [ ];
        problems = [ ];
      }
    else
      ok entry;

  fromPackage =
    p:
    let
      r = p.resolution;
      tarball = r.tarball or null;
      local = r ? directory || (tarball != null && match "file:.*" tarball != null);
    in
    if
      local
      || builtins.elem p.name providedNames
      || builtins.any (item: item.name == p.name && item.version == p.version) providedVersions
    then
      {
        entries = [ ];
        problems = [ ];
      }
    else if (r.type or null) == "git" then
      let
        path = pathOfGit r.repo r.commit (r.path or null);
      in
      if path == null then
        problem "the git repository ${r.repo} in ${pnpmLockName} is not a URL"
      else if !(lockByPath ? ${path}) then
        problem "${pnpmLockName} has the git dependency ${r.repo} at ${r.commit}, whose checkout hash the purifier lockfile does not hold. Run `pnpm-purifier lock`."
      else
        ok (lockByPath.${path} // (if r ? path then { subdirectory = r.path; } else { }))
    else if !(r ? integrity) then
      problem "${p.key} in ${pnpmLockName} has no integrity. Run `pnpm install`, then `pnpm-purifier lock`."
    else if tarball != null then
      file tarball r.integrity p.filters
    else if p.version == null then
      problem "${p.key} in ${pnpmLockName} names no version. Run `pnpm install`, then `pnpm-purifier lock`."
    else
      let
        base = elemAt (match "(@[^/]+/)?(.*)" p.name) 1;
      in
      file "${registryFor p.name}${p.name}/-/${base}-${p.version}.tgz" r.integrity p.filters;

  results = map fromPackage parsed.packages;
  derived = concatMap (r: r.entries) results;
  derivedPaths = listToAttrs (
    map (e: {
      name = e.path;
      value = true;
    }) derived
  );

  # The entries of the purifier lockfile that pnpm-lock.yaml does not
  # imply: the files and metadata of prepare steps.
  extras = filter (a: !(a ? git) && !(derivedPaths ? ${a.path})) lockArtifacts;
in
{
  inherit (parsed) importers;
  entries = derived ++ extras;
  problems = concatMap (r: r.problems) results;
}
