# SPDX-License-Identifier: MIT
#
# The `pnpm-purifier` library namespace: `readLock`, which reads the
# lockfiles of a project into the lock shape of the purifier library
# (nix/lib/read-lock.nix), given the purifier library (`lib.purifier`).
{ ... }:
{

  overlay = final: prev: {
    pnpm-purifier = (prev.pnpm-purifier or { }) // {
      readLock = import ../../nix/lib/read-lock.nix { inherit (final) purifier; };
    };
  };

}
