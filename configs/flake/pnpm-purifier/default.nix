# SPDX-License-Identifier: MIT
{ closure-lib, ... }:
{
  config,
  inputs,
  lib,
  ...
}:
{

  imports = [
    inputs.flake-parts.flakeModules.partitions
    closure-lib.caisson.modules.flake."purifier/purifier-packages"
  ];

  debug = false;

  # The flake publishes the derivations of its scope, `pkgs.pnpm-purifier`,
  # as its packages. The scope is the `default` entry of this flake's
  # package overlay registry (pkg-overlays/): the package set applies it by
  # default, and the flake exports it as `pkgOverlays` and as the plain
  # `overlays.default`.
  purifier.scope = "pnpm-purifier";

  caisson.libOverlays.exported = libOverlays: {
    inherit (libOverlays) default;
  };

  # `nix run github:nix-purifiers/pnpm-purifier -- lock` runs the lock run in
  # the current directory.
  perSystem =
    { pkgs, ... }:
    {
      packages.default = pkgs.pnpm-purifier.cli;
    };

  partitionedAttrs.checks = "checks";
  partitionedAttrs.formatter = "formatter";

  partitions.formatter = {
    extraInputs = (lib.caisson.pins.flake-compat ../../../tests/dependencies).sources;
    module =
      { inputs, ... }:
      {
        imports = [ inputs.treefmt-nix.flakeModule ];
        perSystem.treefmt.programs.nixfmt.enable = true;
      };
  };

  partitions.checks = {
    extraInputs = (lib.caisson.pins.flake-compat ../../../tests/dependencies).sources;
    module =
      { inputs, self, ... }:
      {
        imports = [ inputs.treefmt-nix.flakeModule ];
        perSystem =
          { pkgs, system, ... }:
          {
            checks = import ../../../tests {
              inherit pkgs;
              inherit (self.packages.${system}) cli;
              inherit (pkgs.pnpm-purifier) buildPnpmProject;
              inherit (lib.pnpm-purifier) readLock;
              inherit (lib) purifier;
            };
            treefmt.programs.nixfmt.enable = true;
          };
      };
  };

}
