# `lib.pnpm-purifier.readLock`: reads pnpm-lock.yaml and the purifier
# lockfile of a project into the lock shape of the purifier library
# (CONTRACT.md, "The lock in memory"):
#
#   purifier  "pnpm-purifier"
#   entries   the download entries (entries.nix)
#   outputs   the workspace projects by package name, each { name, path },
#             from the importers of pnpm-lock.yaml with a name in their
#             package.json
#   problems  why the lockfiles cannot be used, each naming the command
#             that fixes it
#
# and, for the builder, `pnpm`: { version, registries }, the pnpm version
# of the lock run (null when nothing names it) and the registries.
#
# Both lockfiles are in `src` by default. The purifier lockfile is
# optional: a project whose pnpm-lock.yaml says everything the build needs
# has none. An external build passes either lockfile from outside `src`.
{ purifier }:
{
  src,
  providedNames ? [ ],
  providedVersions ? [ ],
  lockFile ? src + "/pnpm-purifier.lock.json",
  pnpmLock ? src + "/pnpm-lock.yaml",
}:
let
  inherit (builtins) pathExists readFile fromJSON;

  read = if pathExists lockFile then import ./lock.nix { inherit lockFile; } else null;
  lock = if read == null then null else read.lock;
  lockProblems = if read == null then [ ] else read.problems;

  # A purifier lockfile holds the git hashes and prepare files of one
  # pnpm-lock.yaml; for another it may lack some.
  staleProblems =
    if
      lock != null && pathExists pnpmLock && builtins.hashFile "sha256" pnpmLock != lock.pnpmLockHash
    then
      [
        "pnpm-purifier: ${toString pnpmLock} changed since ${toString lockFile} was written. Run `pnpm-purifier lock`."
      ]
    else
      [ ];

  rootManifest =
    if pathExists (src + "/package.json") then fromJSON (readFile (src + "/package.json")) else { };

  registries = import ./registries.nix {
    npmrcText = if pathExists (src + "/.npmrc") then readFile (src + "/.npmrc") else "";
    override = if lock != null then lock.registries or null else null;
  };

  derived =
    if pathExists pnpmLock then
      import ./entries.nix {
        pnpmLockText = readFile pnpmLock;
        inherit
          registries
          lock
          providedNames
          providedVersions
          ;
        inherit (purifier) admits;
        pnpmLockName = toString pnpmLock;
      }
    else
      {
        importers = [ ];
        entries = [ ];
        problems = [
          "pnpm-purifier: ${toString pnpmLock} does not exist. Run `pnpm install`, then `pnpm-purifier lock`."
        ];
      };

  outputs = builtins.listToAttrs (
    builtins.concatMap (
      dir:
      let
        file = src + "/${dir}/package.json";
        name = if pathExists file then (fromJSON (readFile file)).name or null else null;
      in
      if name == null then
        [ ]
      else
        [
          {
            inherit name;
            value = {
              inherit name;
              path = dir;
            };
          }
        ]
    ) derived.importers
  );

  # The pnpm of the lock run: the version the purifier lockfile records, or
  # the one the `packageManager` field of package.json names.
  version =
    if lock != null && lock ? pnpmVersion then
      lock.pnpmVersion
    else
      let
        m = builtins.match "pnpm@([0-9][^+]*).*" (rootManifest.packageManager or "");
      in
      if m == null then null else builtins.head m;
in
{
  purifier = "pnpm-purifier";
  inherit (derived) entries;
  inherit outputs;
  problems = if lockProblems != [ ] then lockProblems else staleProblems ++ derived.problems;
  pnpm = { inherit version registries; };
}
