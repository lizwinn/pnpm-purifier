# SPDX-License-Identifier: MIT
#
# The `pnpm-purifier` command: the lock run (`pnpm-purifier lock`), pnpm
# on the locked downloads (`pnpm-purifier <pnpm arguments>`), and
# publishing what Nix built (`pnpm-purifier publish`).
#
# It runs the pnpm of the major version that the project's `packageManager`
# field names, from this flake's nixpkgs; a project without the field gets
# the pnpm on PATH, and nixpkgs' default pnpm when PATH has none.
# PNPM_PURIFIER_PNPM names another pnpm. The Nix builds it starts use this
# flake's nixpkgs and the `nix` on PATH.
{
  lib,
  pkgs,
  runCommand,
  makeWrapper,
  nodejs,
  python3,
  nix-prefetch-git,
  pnpm,
  pnpm_10 ? null,
  pnpm_11 ? null,
  pnpm_12 ? null,
}:
let
  # The source of the purifier library flake, at the revision this flake's
  # lock pins. The Nix builds of the command take its `lib.purifier` with
  # builtins.getFlake.
  flakeLock = lib.importJSON ../../flake.lock;
  purifierSource = builtins.fetchTree flakeLock.nodes.${flakeLock.nodes.root.inputs.purifier}.locked;

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
    mkdir -p "$share/nix"
    cp -r ${../../src} "$share/src"
    cp -r ${../../nix/lib} "$share/nix/lib"
    makeWrapper ${lib.getExe nodejs} "$out/bin/pnpm-purifier" \
      --add-flags "$share/src/pnpm-purifier.mjs" \
      --set-default PNPM_PURIFIER_NIX_LIB "$share/nix/lib" \
      --set-default PNPM_PURIFIER_NIXPKGS ${pkgs.path} \
      --set-default PNPM_PURIFIER_LIBRARY ${purifierSource} \
      --set-default PNPM_PURIFIER_INPUT_TOOLS ${purifierSource}/tools \
      --set-default PNPM_PURIFIER_PYTHON ${python3.interpreter} \
      --set-default PNPM_PURIFIER_PNPMS ${lib.escapeShellArg (builtins.toJSON pnpms)} \
      --prefix PATH : ${lib.makeBinPath [ nix-prefetch-git ]} \
      --suffix PATH : ${
        lib.makeBinPath [
          pnpm
          # pnpm runs package scripts with the node on PATH.
          nodejs
        ]
      }
  ''
