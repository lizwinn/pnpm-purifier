# SPDX-License-Identifier: MIT
#
# The `pnpm-purifier` library namespace, given the purifier library
# (`lib.purifier`): `buildPnpmProject`, the builder that
# nix/lib/build-pnpm-project.nix documents, and `readLock`, which reads
# the lockfiles of a project into the lock shape of the purifier library
# (nix/lib/read-lock.nix).
{ ... }:
{

  overlay = final: prev: {
    pnpm-purifier = (prev.pnpm-purifier or { }) // {
      buildPnpmProject = import ../../nix/lib/build-pnpm-project.nix { inherit (final) purifier; };
      readLock = import ../../nix/lib/read-lock.nix { inherit (final) purifier; };
    };
  };

}
