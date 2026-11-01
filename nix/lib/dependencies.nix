# The downloads of a build, as the manifest the local registry serves from:
# a JSON object from each entry's path to a file in the store. `entries`
# are the entries of the lock for the host system, from `entriesFor` of the
# purifier library. The library's fetchEntry fetches each entry: a file
# entry is its download, an inline entry (registry metadata) is a file
# with its contents, and a git entry is the checkout of its commit, which
# git-tarball.nix packs as the tarball pnpm installs.
#
# It is a package for callPackage, with the entries and the purifier
# library (`lib.purifier` of the flake github:nix-purifiers/purifier) among
# its arguments. buildPnpmProject's `dependencies` is this, and the
# interactive mode of `pnpm-purifier` builds it through the builder.
{
  lib,
  callPackage,
  fetchurl,
  fetchgit,
  runCommand,
  unzip,
  zstd,
  python3,
  writeText,
  purifier,
  entries,
  # Fetchers for the library's fetchEntry, by name, such as a `fetchurl`
  # with credentials (nixpkgs' fetchurl takes `netrcPhase`) or a mirror.
  fetchers ? { },
}:
let
  fetch = purifier.fetchEntry (
    {
      inherit
        fetchurl
        fetchgit
        runCommand
        unzip
        zstd
        python3
        writeText
        ;
    }
    // fetchers
  );
  gitTarball = callPackage ./git-tarball.nix { };
  # The fields of an entry that the library fetches by; the platform
  # filters, the systems and the subdirectory stay with the purifier.
  entryOf =
    entry:
    removeAttrs entry [
      "os"
      "cpu"
      "libc"
      "systems"
      "subdirectory"
    ];
  # A git entry's path ends in <commit>[/<directory>]/package.tgz; the name
  # of its tarball takes the component before package.tgz.
  tarballName =
    path:
    let
      parts = lib.splitString "/" path;
    in
    "${lib.elemAt parts (lib.length parts - 2)}-package.tgz";
  fileOf =
    entry:
    if entry ? git then
      gitTarball {
        name = tarballName entry.path;
        checkout = fetch (entryOf entry);
        subdirectory = entry.subdirectory or null;
      }
    else
      fetch (entryOf entry);
in
writeText "pnpm-purifier-registry.json" (
  builtins.toJSON (
    builtins.listToAttrs (
      map (e: {
        name = e.path;
        value = "${fileOf e}";
      }) entries
    )
  )
)
