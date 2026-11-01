# Reads a pnpm-purifier lockfile (written by `pnpm-purifier lock`).
#
# Needs no nixpkgs.
{ lockFile }:
let
  lock = builtins.fromJSON (builtins.readFile lockFile);

  supportedVersion = import ./lock-version.nix;
  storeName = import ./store-name.nix;

  # A lockfile that is not the shape `pnpm-purifier lock` writes, such as
  # one edited by hand, stops evaluation with what is wrong.
  malformed =
    problem:
    throw "pnpm-purifier: ${toString lockFile} ${problem}. Run `pnpm-purifier lock` to write it again.";
  checkArtifact =
    a:
    if !(builtins.isAttrs a) || !(a ? path) then
      malformed "has an artifact without a path"
    else if a ? contents || a ? git || (a ? url && a ? mirrors && a ? hash) then
      true
    else
      malformed "has an artifact (${a.path}) that is none of a file, a git or an inline entry";
in
assert builtins.isAttrs lock || malformed "is not a JSON object";
assert
  (lock.version or null) == supportedVersion
  || throw "pnpm-purifier: ${toString lockFile} has lock format version ${
    toString (lock.version or "none")
  }; this library reads version ${toString supportedVersion}. Run `pnpm-purifier lock` with the pnpm-purifier version that provides this library.";
assert builtins.isList (lock.artifacts or null) || malformed "has no list of artifacts";
assert builtins.isList (lock.projects or null) || malformed "has no list of projects";
assert builtins.all checkArtifact lock.artifacts;
lock
// {
  inherit storeName;

  # The store name of an artifact: its file name, made a valid store name.
  # A git dependency's path ends in package.tgz, so its name also takes the
  # commit before it. An inline entry is registry metadata, and its name
  # ends in .json, which the local registry serves as JSON.
  artifactName =
    artifact:
    let
      parts = builtins.filter builtins.isString (builtins.split "/" artifact.path);
      n = builtins.length parts;
    in
    if artifact ? git then
      storeName "${builtins.elemAt parts (n - 2)}-${builtins.elemAt parts (n - 1)}"
    else if artifact ? contents then
      storeName "${builtins.baseNameOf artifact.path}.json"
    else
      storeName (builtins.baseNameOf artifact.path);

  # The directory of the repository that a git dependency names, or null.
  gitSubdirectory = artifact: (lock.gitSubdirectories or { }).${artifact.path} or null;

  # The artifacts that apply to a Nix system: the lock holds the native
  # packages of every platform it covers, and a build on one system reads
  # only its own.
  artifactsFor = system: builtins.filter (import ./admits.nix system) lock.artifacts;

  projectsByName = builtins.listToAttrs (
    map (p: {
      inherit (p) name;
      value = p;
    }) lock.projects
  );
}
