# Reads a pnpm-purifier lockfile (written by `pnpm-purifier lock`), which
# holds only what pnpm-lock.yaml cannot say:
#
#   version         the format version
#   pnpmLockHash    the sha256 of the pnpm-lock.yaml the lock was made
#                   from
#   contentHash     the sha256 of the lockfile's canonical JSON without
#                   this field
#   pnpmVersion     the pnpm that made the lock, when package.json names
#                   none in its `packageManager` field
#   registries      the registries, when the user config sets ones that
#                   the .npmrc of the project does not
#   artifacts       the git dependencies, with the hashes of their
#                   checkouts, and the files and registry metadata that
#                   the prepare steps of git dependencies read
#
# The result is { lock, problems }: `lock` is the lockfile, or null when it
# cannot be used, and `problems` says why, naming the command that fixes
# it. A file that is not JSON at all stops evaluation.
#
# Needs no nixpkgs.
{ lockFile }:
let
  lock = builtins.fromJSON (builtins.readFile lockFile);

  supportedVersion = import ./lock-version.nix;

  fix = "Run `pnpm-purifier lock` to write it again.";
  malformed = problem: "pnpm-purifier: ${toString lockFile} ${problem}. ${fix}";
  artifactProblem =
    a:
    if !(builtins.isAttrs a) || !(a ? path) then
      malformed "has an artifact without a path"
    else if a ? contents || a ? git || (a ? url && a ? mirrors && a ? hash) then
      null
    else
      malformed "has an artifact (${a.path}) that is none of a file, a git or an inline entry";

  problems =
    if !builtins.isAttrs lock then
      [ (malformed "is not a JSON object") ]
    else if (lock.version or null) != supportedVersion then
      [
        "pnpm-purifier: ${toString lockFile} has lock format version ${
          toString (lock.version or "none")
        }; this library reads version ${toString supportedVersion}. Run `pnpm-purifier lock` with the pnpm-purifier version that provides this library."
      ]
    else if !builtins.isList (lock.artifacts or null) then
      [ (malformed "has no list of artifacts") ]
    else if !builtins.isString (lock.pnpmLockHash or null) then
      [ (malformed "has no pnpmLockHash") ]
    else
      let
        bad = builtins.filter (p: p != null) (map artifactProblem lock.artifacts);
      in
      if bad != [ ] then
        [ (builtins.head bad) ]
      # The lockfile's hash of its own content (canonical JSON without the
      # field, as builtins.toJSON writes it) shows an edit by hand.
      else if
        builtins.hashString "sha256" (builtins.toJSON (removeAttrs lock [ "contentHash" ]))
        != (lock.contentHash or "")
      then
        [
          (malformed "was edited after `pnpm-purifier lock` wrote it: its content does not match its contentHash")
        ]
      else
        [ ];
in
{
  lock = if problems == [ ] then lock else null;
  inherit problems;
}
