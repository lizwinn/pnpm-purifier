# SPDX-License-Identifier: MIT
#
# The default package overlay. It adds one attribute to the package set:
# the scope `pkgs.pnpm-purifier`, made with lib.makeScope from the packages
# of pkgs/ (`.cli`, the command, and `.buildPnpmProject`, the builder of
# nix/lib/build-pnpm-project.nix). A package written for callPackage takes
# the scope by name. A consumer that lists this flake in `projects` holds
# the overlay as `pnpm-purifier/default`, which its package sets apply by
# default.
{ closure-lib, ... }:
{
  overlay = closure-lib.caisson.nixpkgs.mkPackagesOverlay ../../pkgs "pnpm-purifier";
}
