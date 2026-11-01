# SPDX-License-Identifier: MIT
#
# The `pnpm-purifier` command: the lock run (`pnpm-purifier lock`) and pnpm
# on the locked downloads (`pnpm-purifier <pnpm arguments>`).
#
# It runs the pnpm of the major version that the project's `packageManager`
# field names, from this flake's nixpkgs; a project without the field gets
# the pnpm on PATH, and nixpkgs' default pnpm when PATH has none.
# PNPM_PURIFIER_PNPM names another pnpm. Interactive mode realizes the
# lockfile with the `nix` on PATH.
{
  lib,
  runCommand,
  makeWrapper,
  nodejs,
  pnpm,
  pnpm_10 ? null,
  pnpm_11 ? null,
  pnpm_12 ? null,
}:
let
  pnpms = lib.mapAttrs (_: p: lib.getExe p) (
    lib.filterAttrs (_: p: p != null) {
      "10" = pnpm_10;
      "11" = pnpm_11;
      "12" = pnpm_12;
    }
  );
in
runCommand "pnpm-purifier"
  {
    nativeBuildInputs = [ makeWrapper ];
    meta = {
      description = "Lock the downloads of a pnpm project and build it offline with Nix";
      mainProgram = "pnpm-purifier";
    };
  }
  ''
    share="$out/share/pnpm-purifier"
    mkdir -p "$share/src" "$share/nix"
    cp ${../../src/pnpm-purifier.mjs} "$share/src/pnpm-purifier.mjs"
    cp -r ${../../nix/lib} "$share/nix/lib"
    makeWrapper ${lib.getExe nodejs} "$out/bin/pnpm-purifier" \
      --add-flags "$share/src/pnpm-purifier.mjs" \
      --set-default PNPM_PURIFIER_NIX_LIB "$share/nix/lib" \
      --set-default PNPM_PURIFIER_PNPMS ${lib.escapeShellArg (builtins.toJSON pnpms)} \
      --suffix PATH : ${
        lib.makeBinPath [
          pnpm
          # pnpm runs package scripts with the node on PATH.
          nodejs
        ]
      }
  ''
