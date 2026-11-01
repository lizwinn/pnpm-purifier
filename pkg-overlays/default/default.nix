# SPDX-License-Identifier: MIT
#
# The default package overlay. It adds the packages of pkgs/ under
# `pkgs.pnpm-purifier` (`.cli`). The builder is in the library, as
# `lib.pnpm-purifier.buildPnpmProject`. A consumer that lists this flake in
# `projects` holds the overlay as `pnpm-purifier/default`, which its
# package sets apply by default.
{ closure-lib, ... }:
{
  overlay = closure-lib.caisson.nixpkgs.mkPackagesOverlay ../../pkgs "pnpm-purifier";
}
