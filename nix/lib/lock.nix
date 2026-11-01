# Reads a pnpm-purifier lockfile (written by `pnpm-purifier lock`).
#
# Needs no nixpkgs.
{ lockFile }:
let
  lock = builtins.fromJSON (builtins.readFile lockFile);

  supportedVersion = import ./lock-version.nix;
  storeName = import ./store-name.nix;
in
assert
  lock.version == supportedVersion
  || throw "pnpm-purifier: ${toString lockFile} has lock format version ${toString lock.version}; this library reads version ${toString supportedVersion}. Run `pnpm-purifier lock` with the pnpm-purifier version that provides this library.";
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
