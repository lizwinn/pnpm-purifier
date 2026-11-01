# The locked downloads of a lockfile, as the manifest the local registry
# serves from: a JSON object from each artifact's lockfile path to a file
# in the store. The purifier library's fetchEntry fetches each entry: a
# file entry is its download, an inline entry (registry metadata) is a
# file with its contents, and a git entry is the checkout of its commit,
# which git-tarball.nix packs as the tarball pnpm installs. The manifest
# holds the artifacts whose npm platform filters admit the host system,
# by the library's `admits`.
#
# It is a package for callPackage, with the lockfile and the purifier
# library (`lib.purifier` of the flake github:nix-purifiers/purifier) among
# its arguments. buildPnpmProject's `dependencies` is this, and the
# interactive mode of `pnpm-purifier` builds it on its own.
{
  pkgs,
  stdenvNoCC,
  callPackage,
  writeText,
  purifier,
  lockFile,
  # Replaces nixpkgs' fetchurl for file entries, as fetchEntry takes it:
  # the place for credentials, such as a fetchurl with `netrcPhase`.
  fetchurl ? pkgs.fetchurl,
}:
let
  lock = import ./lock.nix { inherit lockFile; };
  system = stdenvNoCC.hostPlatform.system;
  fetch = purifier.fetchEntry { inherit pkgs fetchurl; };
  gitTarball = callPackage ./git-tarball.nix { };
  admitted =
    a:
    purifier.admits {
      os = a.os or null;
      cpu = a.cpu or null;
      libc = a.libc or null;
    } system;
  # The fields of an entry that the library knows; the platform filters
  # stay with the purifier.
  entryOf =
    a:
    removeAttrs a [
      "os"
      "cpu"
      "libc"
    ];
  fileOf =
    a:
    if a ? git then
      gitTarball {
        name = lock.artifactName a;
        checkout = fetch (entryOf a);
        subdirectory = lock.gitSubdirectory a;
      }
    else
      fetch (entryOf a);
in
(writeText "pnpm-purifier-registry.json" (
  builtins.toJSON (
    builtins.listToAttrs (
      map (a: {
        name = a.path;
        value = "${fileOf a}";
      }) (builtins.filter admitted lock.artifacts)
    )
  )
)).overrideAttrs
  { passthru = { inherit lock; }; }
