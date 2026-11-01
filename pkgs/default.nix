# SPDX-License-Identifier: MIT
{ callPackage, ... }:
{
  # The `pnpm-purifier` command.
  cli = callPackage ./cli { };
}
