# The locked downloads of a lockfile, as the manifest the local registry
# serves from: a JSON object from each artifact's lockfile path to a file
# in the store. A file entry ({ path, url, mirrors, hash }) maps to its
# download. A git entry ({ path, git = { url, rev, submodules, leaveDotGit },
# hash }) maps to the tarball that git-tarball.nix packs from its checkout.
# An inline entry ({ path, contents }), which holds registry metadata, maps
# to a file with its contents. The manifest holds the artifacts that apply
# to the host system.
#
# It is a package for callPackage, with the lockfile among its arguments.
# buildPnpmProject's `dependencies` is this, and the interactive mode of
# `pnpm-purifier` builds it on its own.
{
  stdenvNoCC,
  callPackage,
  writeText,
  lockFile,
  # Replaces the built-in fetcher of file entries; see fetch.nix.
  fetchurl ? null,
}:
let
  lock = import ./lock.nix { inherit lockFile; };
  fetch = import ./fetch.nix { inherit lock fetchurl; };
  gitTarball = callPackage ./git-tarball.nix { };
  fileOf =
    a:
    if a ? git then
      gitTarball {
        name = lock.artifactName a;
        inherit (a.git)
          url
          rev
          submodules
          leaveDotGit
          ;
        inherit (a) hash;
        subdirectory = lock.gitSubdirectory a;
      }
    else if a ? contents then
      writeText (lock.artifactName a) a.contents
    else
      fetch a;
in
(writeText "pnpm-purifier-registry.json" (
  builtins.toJSON (
    builtins.listToAttrs (
      map (a: {
        name = a.path;
        value = "${fileOf a}";
      }) (lock.artifactsFor stdenvNoCC.hostPlatform.system)
    )
  )
)).overrideAttrs
  { passthru = { inherit lock; }; }
