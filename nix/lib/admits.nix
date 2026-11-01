# Whether a locked artifact applies to a Nix system, by npm's platform
# filters: the `os`, `cpu` and `libc` lists the lock run copies from the
# package's package.json. A list either names the values a package
# supports, or names values it excludes with a leading "!". An artifact
# without a filter applies to every system.
#
# Needs no nixpkgs, like lock.nix.
system: artifact:
let
  parts = builtins.match "([^-]+)-(.+)" system;
  arch = builtins.elemAt parts 0;
  kernel = builtins.elemAt parts 1;
  # npm's names for the CPU, operating system and C library of a system.
  # Linux on Nix uses glibc.
  npm = {
    cpu =
      {
        x86_64 = "x64";
        aarch64 = "arm64";
        i686 = "ia32";
        armv7l = "arm";
        riscv64 = "riscv64";
        powerpc64le = "ppc64";
      }
      .${arch} or arch;
    os = kernel;
    libc = if kernel == "linux" then "glibc" else null;
  };
  allows =
    key:
    let
      list = artifact.${key} or [ ];
      excluded = builtins.filter (v: builtins.substring 0 1 v == "!") list;
      included = builtins.filter (v: builtins.substring 0 1 v != "!") list;
      value = npm.${key};
    in
    list == [ ]
    || value == null
    || (!(builtins.elem "!${value}" excluded) && (included == [ ] || builtins.elem value included));
in
allows "os" && allows "cpu" && allows "libc"
