# Reads a pnpm-purifier lockfile (written by `pnpm-purifier lock`).
#
# Needs no nixpkgs: the interactive mode evaluates this with nothing but
# the Nix installation it runs.
{ lockFile }:
let
  lock = builtins.fromJSON (builtins.readFile lockFile);

  supportedVersion = import ./lock-version.nix;

  # A store path name from a file name. Store path names allow
  # [A-Za-z0-9+._?=-], must not start with a dot, and are at most 211
  # characters; every other character becomes "_". The interactive mode and
  # the sandboxed build both name their fetches with this function, so they
  # share store paths.
  storeName =
    fileName:
    let
      # builtins.split alternates the text between matches with a list per
      # match.
      replaced = builtins.concatStringsSep "" (
        map (part: if builtins.isList part then "_" else part) (
          builtins.split "[^A-Za-z0-9+._?=-]" fileName
        )
      );
      undotted = builtins.head (builtins.match "\\.*(.*)" replaced);
      nonEmpty = if undotted == "" then "file" else undotted;
    in
    builtins.substring 0 200 nonEmpty;
in
assert
  lock.version == supportedVersion
  || throw "pnpm-purifier: ${toString lockFile} has lock format version ${toString lock.version}; this library reads version ${toString supportedVersion}. Run `pnpm-purifier lock` with the pnpm-purifier version that provides this library.";
lock
// {
  inherit storeName;

  # The fetch name of an artifact: its file name, made a valid store name.
  artifactName = artifact: storeName (builtins.baseNameOf artifact.path);

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
