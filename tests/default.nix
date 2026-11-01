# SPDX-License-Identifier: MIT
#
# The flake's checks. Every one builds in the sandbox; the only network
# access is the fixed-output fetches of locked artifacts.
{
  pkgs,
  # The flake's default package overlay, which adds buildPnpmProject.
  overlay,
  cli,
}:
let
  inherit (pkgs) lib;

  # The fixture builds the way a consumer's package does: through
  # buildPnpmProject of a package set the overlay applies to.
  withOverlay = pkgs.extend overlay;
  inherit (withOverlay) buildPnpmProject;

  # A pnpm 12 workspace (tests/fixtures/workspace): @example/greet, a
  # library with a registry dependency, and @example/app, a private app
  # that depends on greet and bundles itself with esbuild, whose native
  # binary comes from a platform-specific optional dependency.
  workspace = buildPnpmProject { src = ./fixtures/workspace; };
  app = workspace.packages."@example/app";
  greet = workspace.packages."@example/greet";

  # Whether evaluating `value` fails, which tryEval catches for a throw or
  # a failed assertion.
  fails = value: !(builtins.tryEval (builtins.deepSeq value value)).success;

in
{
  inherit cli;

  # The app runs from its deployed tree, with its workspace dependency and
  # its registry dependency resolved.
  workspace-app = pkgs.runCommand "workspace-app" { } ''
    out_text=$(${lib.getExe app} Nix)
    echo "$out_text"
    grep -F "Hello, " <<<"$out_text"
    grep -F "Nix" <<<"$out_text"
    grep -F "One day is 86400000 milliseconds." <<<"$out_text"
    touch $out
  '';

  # A project with a dependency from each source pnpm can lock
  # (tests/fixtures/sources): GitHub, given as github: and as git+https:,
  # which pnpm fetches as codeload tarballs; a tarball URL outside the
  # registry; a git repository on a host pnpm does not know, which pnpm
  # clones; a local directory; and a local tarball. The project's bin
  # imports each one.
  sources =
    let
      project = (buildPnpmProject { src = ./fixtures/sources; }).packages.sources;
    in
    pkgs.runCommand "sources" { } ''
      out_text=$(${lib.getExe project})
      echo "$out_text"
      grep -Fx 'github: a\.b' <<<"$out_text"
      grep -Fx 'git+https github: true' <<<"$out_text"
      grep -Fx 'tarball url: true' <<<"$out_text"
      grep -Fx 'git: 3600000' <<<"$out_text"
      grep -Fx 'directory: vendored' <<<"$out_text"
      grep -Fx 'tarball file: packed' <<<"$out_text"
      touch $out
    '';

  # `pnpm-purifier publish` publishes the tarball output of a project with
  # `pnpm publish`. The check publishes greet's tarball to a registry on
  # the loopback interface (tests/fake-registry.mjs) and compares what the
  # registry received with the file Nix built.
  publish =
    pkgs.runCommand "publish"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          workspace.pnpm
        ];
      }
      ''
        export HOME="$TMPDIR/home" XDG_RUNTIME_DIR="$TMPDIR/run"
        mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
        node ${./fake-registry.mjs} "$TMPDIR/port" "$TMPDIR/published.tgz" &
        while [ ! -s "$TMPDIR/port" ]; do sleep 0.1; done
        port=$(cat "$TMPDIR/port")
        echo "//127.0.0.1:$port/:_authToken=check" > "$HOME/.npmrc"
        tarball=${greet.tarball}/example-greet-1.0.0.tgz
        pnpm publish "$tarball" --registry "http://127.0.0.1:$port/" --no-git-checks
        cmp "$tarball" "$TMPDIR/published.tgz"
        touch $out
      '';

  # A library that is not private gets the tarball `pnpm pack` makes.
  workspace-greet-tarball = pkgs.runCommand "workspace-greet-tarball" { } ''
    tarball=${greet.tarball}/example-greet-1.0.0.tgz
    ${lib.getExe pkgs.gnutar} -xzf "$tarball" -O package/package.json | grep -F '"name": "@example/greet"'
    touch $out
  '';

  # A build reads the native packages of its own system only. The lock
  # holds esbuild's binary package for each of the four platforms it covers.
  platform-filters =
    let
      admits = import ../nix/lib/admits.nix;
      # The artifacts that `dependencies` holds for the host system.
      hostPaths = map (a: a.path) (workspace.lock.artifactsFor pkgs.stdenv.hostPlatform.system);
      esbuildPackages = builtins.filter (lib.hasInfix "/@esbuild/") hostPaths;
      linuxX64 = "https/registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.25.12.tgz";
    in
    assert
      pkgs.stdenv.hostPlatform.system != "x86_64-linux"
      || esbuildPackages == [ linuxX64 ]
      || throw "the x86_64-linux manifest holds ${toString esbuildPackages}";
    assert admits "x86_64-linux" { };
    assert admits "aarch64-darwin" {
      os = [ "darwin" ];
      cpu = [ "arm64" ];
    };
    assert !(admits "x86_64-linux" { os = [ "darwin" ]; });
    assert !(admits "x86_64-linux" { cpu = [ "arm64" ]; });
    assert admits "x86_64-linux" { os = [ "!win32" ]; };
    assert !(admits "x86_64-linux" { os = [ "!linux" ]; });
    assert !(admits "x86_64-linux" { libc = [ "musl" ]; });
    assert admits "aarch64-darwin" { libc = [ "musl" ]; };
    pkgs.runCommand "platform-filters" { } "touch $out";

  # Evaluation fails for a lock that does not match pnpm-lock.yaml (here the
  # lock of the other fixture), and for a lock of another format version.
  lock-checks =
    assert fails
      (buildPnpmProject {
        src = ./fixtures/workspace;
        lockFile = ./fixtures/sources/pnpm-purifier.lock.json;
      }).packages.sources.drvPath;
    assert fails
      (buildPnpmProject {
        src = ./fixtures/workspace;
        lockFile = ./fixtures/other-version.lock.json;
      }).packages."@example/app".drvPath;
    pkgs.runCommand "lock-checks" { } "touch $out";
}
