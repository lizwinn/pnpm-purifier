# SPDX-License-Identifier: MIT
#
# The packages of the `pnpm-purifier` scope, which the package overlay adds
# to the package set with lib.makeScope.
{ callPackage, lib, ... }:
{
  # The `pnpm-purifier` command.
  cli = callPackage ./cli { };

  # The builder (nix/lib/build-pnpm-project.nix), with the purifier library
  # of this flake as `purifier`. `pnpm-purifier.buildPnpmProject.override`
  # replaces any package it takes, and `pnpm-purifier.overrideScope`
  # replaces what the scope shares.
  buildPnpmProject = callPackage ../nix/lib/build-pnpm-project.nix {
    inherit (lib) purifier;
  };
}
