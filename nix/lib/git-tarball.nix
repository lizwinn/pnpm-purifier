# A git dependency as the tarball pnpm installs it from: the checkout of
# the locked commit, which the purifier library's fetchEntry fetches,
# packed under `package/`. The local registry serves it in place of the
# git repository, so pnpm installs it without git. `subdirectory` is the
# directory of the repository that holds the package, for a dependency
# that names one (`#path:` in pnpm).
{
  runCommand,
  gnutar,
  gzip,
}:
{
  name,
  checkout,
  subdirectory ? null,
}:
let
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
