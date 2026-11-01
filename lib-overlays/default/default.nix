# SPDX-License-Identifier: MIT
#
# The `pnpm-purifier` library namespace. It holds nothing: the builder
# needs a package set, so it is the package `buildPnpmProject` that the
# default package overlay adds.
{ ... }:
{

  overlay = final: prev: {
    pnpm-purifier = prev.pnpm-purifier or { };
  };

}
