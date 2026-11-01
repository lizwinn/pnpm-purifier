# A git dependency as the tarball pnpm installs it from: a checkout of the
# locked commit, packed under `package/`. The local registry serves it in
# place of the git repository, so pnpm installs it without git.
#
# The checkout comes from nixpkgs' fetchgit, so `hash` is the hash that
# nix-prefetch-git reports. pnpm clones git dependencies without their
# submodules, and the lock records `submodules = false` for that.
# `subdirectory` is the directory of the repository that holds the
# package, for a dependency that names one (`#path:` in pnpm).
{
  runCommand,
  fetchgit,
  gnutar,
  gzip,
}:
{
  name,
  url,
  rev,
  hash,
  submodules,
  leaveDotGit,
  subdirectory ? null,
}:
let
  checkout = fetchgit {
    inherit
      url
      rev
      hash
      leaveDotGit
      ;
    fetchSubmodules = submodules;
  };
  root = if subdirectory == null then checkout else "${checkout}/${subdirectory}";
in
runCommand name
  {
    nativeBuildInputs = [
      gnutar
      gzip
    ];
  }
  ''
    tar --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
      --transform 's,^\.,package,' -C ${root} -cf - . | gzip -9n > $out
  ''
