# What the interactive mode builds.
#
# `fetches` is every locked artifact; `nix build` of it downloads them in
# parallel. `manifest` is then a store file mapping each artifact's
# lockfile path to its store path, which the local registry serves from.
# The file refers to every artifact, so one GC root on it keeps them all
# alive.
#
# A file made with builtins.toFile may refer to store paths but not to
# derivation outputs, so the manifest names each artifact through
# builtins.fetchurl: with the same name and hash, it is the same
# fixed-output store path a fetch derivation produces, and it is already
# valid once `fetches` is built, so nothing downloads twice.
{
  lockFile,
  libDir ? ./.,
  # The system whose artifacts the manifest holds.
  system ? builtins.currentSystem,
}:
let
  lock = import (libDir + "/lock.nix") { inherit lockFile; };
  fetch = import (libDir + "/fetch.nix") { inherit lock; };
  byPath =
    f:
    builtins.listToAttrs (
      map (artifact: {
        name = artifact.path;
        value = f artifact;
      }) (lock.artifactsFor system)
    );
in
{
  fetches = byPath fetch;
  manifest = builtins.toFile "pnpm-purifier-registry.json" (
    builtins.toJSON (
      byPath (
        artifact:
        builtins.fetchurl {
          inherit (artifact) url;
          name = lock.artifactName artifact;
          sha256 = artifact.hash;
        }
      )
    )
  );
}
