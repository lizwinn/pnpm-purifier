# The locked downloads of a lockfile, as the manifest the local registry
# serves from: a JSON object from each artifact's lockfile path to its
# store path. It holds the artifacts that apply to the host system. It is a
# package for callPackage, with the lockfile among its arguments.
# buildPnpmProject's `dependencies` is this.
{
  stdenvNoCC,
  writeText,
  lockFile,
  # Replaces the built-in fetcher; see fetch.nix.
  fetchurl ? null,
}:
let
  lock = import ./lock.nix { inherit lockFile; };
  fetch = import ./fetch.nix { inherit lock fetchurl; };
in
(writeText "pnpm-purifier-registry.json" (
  builtins.toJSON (
    builtins.listToAttrs (
      map (a: {
        name = a.path;
        value = "${fetch a}";
      }) (lock.artifactsFor stdenvNoCC.hostPlatform.system)
    )
  )
)).overrideAttrs
  { passthru = { inherit lock; }; }
