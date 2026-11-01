# SPDX-License-Identifier: MIT
#
# The default package overlay. It adds the packages of pkgs/ under
# `pkgs.pnpm-purifier` (`.cli`), and the builder `pkgs.buildPnpmProject`
# (nix/lib/build-pnpm-project.nix) beside them, where nixpkgs keeps its own
# builders, so a package written for callPackage takes it by name. A
# consumer that lists this flake in `projects` holds it as
# `pnpm-purifier/default`, which its package sets apply by default.
{ closure-lib, ... }:
let
  packages = closure-lib.caisson.nixpkgs.mkPackagesOverlay ../../pkgs "pnpm-purifier";
in
{
  overlay =
    final: prev:
    packages final prev
    // {
      buildPnpmProject = final.callPackage ../../nix/lib/build-pnpm-project.nix { };
    };
}
