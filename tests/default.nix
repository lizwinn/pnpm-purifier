# SPDX-License-Identifier: MIT
#
# The flake's checks. Every one builds in the sandbox; the only network
# access is the fixed-output fetches of locked artifacts. The conformance
# checks that need Nix or the network (conformance-relock,
# conformance-update, conformance-rebuild and conformance-offline) are CI
# jobs of the same name in .github/workflows/check.yml.
{
  pkgs,
  cli,
  # `pkgs.pnpm-purifier.buildPnpmProject`, which the package overlay of this
  # flake adds.
  buildPnpmProject,
  # `lib.pnpm-purifier.readLock` of this flake.
  readLock,
  # The purifier library, `lib.purifier`.
  purifier,
}:
let
  inherit (pkgs) lib;

  # Every fixture builds the way a consumer's project does.
  build = buildPnpmProject;

  # A pnpm 12 workspace (tests/fixtures/workspace): @example/greet, a
  # library with a registry dependency and a build script that runs by its
  # path, and @example/app, a private app that depends on greet and bundles
  # itself with esbuild, whose native binary comes from a platform-specific
  # optional dependency. Its pnpm-lock.yaml says everything the build
  # needs, so it has no purifier lockfile.
  workspace = build { src = ./fixtures/workspace; };
  app = workspace.packages."@example/app";
  greet = workspace.packages."@example/greet";

  # Whether evaluating `value` fails, which tryEval catches for a throw or
  # a failed assertion.
  fails = value: !(builtins.tryEval (builtins.deepSeq value value)).success;

  # The lock of the sources fixture, whose purifier lockfile holds the
  # checkout hash of a git dependency, read with another purifier lockfile
  # or with another project tree. `problems` must name `pnpm-purifier
  # lock`, and the downloads of a build must fail during evaluation.
  sourcesLock = args: readLock ({ src = ./fixtures/sources; } // args);
  sourcesWith = args: (build ({ src = ./fixtures/sources; } // args)).dependencies;
  rejected =
    name: args: pattern:
    let
      problems = (sourcesLock args).problems;
    in
    assert lib.assertMsg (
      problems != [ ] && builtins.all (p: lib.hasInfix "pnpm-purifier lock" p) problems
    ) "${name}: the problems ${builtins.toJSON problems} do not all name `pnpm-purifier lock`";
    assert lib.assertMsg (builtins.any (
      p: builtins.match pattern p != null
    ) problems) "${name}: no problem in ${builtins.toJSON problems} matches ${pattern}";
    assert fails (sourcesWith args).drvPath;
    pkgs.runCommand name { } "touch $out";

  # A fixture without its purifier lockfile, as a project whose author
  # keeps only pnpm-lock.yaml.
  withoutPurifierLock =
    fixture:
    builtins.path {
      path = fixture;
      name = "without-purifier-lock";
      filter = path: _: baseNameOf path != "pnpm-purifier.lock.json";
    };

  # A fixture without either lockfile, as a project whose external build
  # keeps both outside the repository.
  withoutLocks =
    fixture:
    builtins.path {
      path = fixture;
      name = "without-locks";
      filter =
        path: _:
        !(builtins.elem (baseNameOf path) [
          "pnpm-purifier.lock.json"
          "pnpm-lock.yaml"
        ]);
    };
in
{
  inherit cli;
  composition-producer = greet;
  composition-repository = workspace.projections.npm;

  # A caller needs only the pnpm major used by its project, rather than
  # every major that the purifier can build with.
  available-pnpm =
    let
      buildWithOnly12 = lib.callPackageWith (removeAttrs pkgs [
        "pnpm_10"
        "pnpm_11"
      ]) ../nix/lib/build-pnpm-project.nix { inherit purifier; };
      restricted = buildWithOnly12 { src = ./fixtures/workspace; };
      missing = buildPnpmProject.override { pnpm_12 = null; };
      explicit = missing {
        src = ./fixtures/workspace;
        pnpm = pkgs.pnpm_12;
      };
    in
    assert restricted.packages."@example/app".drvPath == app.drvPath;
    assert fails (missing { src = ./fixtures/workspace; }).packages."@example/app".drvPath;
    assert explicit.packages."@example/app".drvPath == app.drvPath;
    pkgs.runCommand "available-pnpm" { } "touch $out";

  # The fixture packages themselves, which the conformance-rebuild job
  # builds a second time with `nix build --rebuild`.
  fixture-app = app;
  fixture-greet = greet;

  # The workspace's test scripts, run in the sandbox.
  fixture-tests = workspace.tests;

  # --- The conformance checks of the purifier contract ----------------------

  # A lockfile older than the project fails during evaluation, naming
  # `pnpm-purifier lock`: the purifier lockfile of the sources fixture was
  # made from the pnpm-lock.yaml of that fixture, and here it is the
  # external lockfile of the prepare fixture, whose pnpm-lock.yaml differs.
  conformance-stale = rejected "conformance-stale" {
    src = withoutPurifierLock ./fixtures/prepare;
    lockFile = ./fixtures/sources/pnpm-purifier.lock.json;
  } ".*changed since.*";

  # A lockfile with a changed hash fails during evaluation: the hash of the
  # git entry no longer matches the lockfile's contentHash.
  conformance-tampered = rejected "conformance-tampered" {
    lockFile = ./fixtures/negative/tampered-hash.lock.json;
  } ".*does not match its contentHash.*";

  # A lockfile without an entry the build needs (the checkout hash of the
  # git dependency, with a contentHash that matches) fails during
  # evaluation, naming the dependency and `pnpm-purifier lock`.
  conformance-missing = rejected "conformance-missing" {
    lockFile = ./fixtures/negative/missing-entry.lock.json;
  } ".*git dependency https://salsa.debian.org/js-team/node-ms.git at 3171b26.*";

  # A lockfile that is not valid fails during evaluation: an artifact that
  # is none of a file, a git or an inline entry, and a lock of another
  # format version.
  conformance-malformed =
    assert fails (sourcesWith { lockFile = ./fixtures/negative/malformed.lock.json; }).drvPath;
    assert fails (sourcesWith { lockFile = ./fixtures/other-version.lock.json; }).drvPath;
    (rejected "conformance-malformed" {
      lockFile = ./fixtures/negative/malformed.lock.json;
    } ".*none of a file, a git or an inline entry.*");

  # A project whose source holds only the files of pnpm builds from a
  # purifier lockfile kept outside it, as a packaging flake keeps one for a
  # project its author does not change: the sources fixture without its
  # purifier lockfile, which is given as `lockFile`.
  # The same fixture also builds with pnpm-lock.yaml kept outside `src` and
  # given as `pnpmLock`.
  conformance-external =
    let
      project =
        (build {
          src = withoutPurifierLock ./fixtures/sources;
          lockFile = ./fixtures/sources/pnpm-purifier.lock.json;
        }).packages.sources;
      withToolLock =
        (build {
          src = withoutLocks ./fixtures/sources;
          lockFile = ./fixtures/sources/pnpm-purifier.lock.json;
          pnpmLock = ./fixtures/sources/pnpm-lock.yaml;
        }).packages.sources;
    in
    pkgs.runCommand "conformance-external" { } ''
      ${project.artifacts.bin.sources} | grep -Fx 'git: 3600000'
      ${withToolLock.artifacts.bin.sources} | grep -Fx 'git: 3600000'
      touch $out
    '';

  # The lock in memory has the shape of the purifier library (checkLock
  # accepts it), names its purifier, and has the workspace projects as its
  # outputs.
  lock-shape =
    let
      lock = readLock { src = ./fixtures/workspace; };
    in
    assert purifier.checkLock lock == lock;
    assert lock.purifier == "pnpm-purifier";
    assert
      builtins.attrNames lock.outputs == [
        "@example/app"
        "@example/greet"
        "workspace-root"
      ];
    assert lock.outputs."@example/greet".path == "packages/greet";
    assert (sourcesLock { }).problems == [ ];
    pkgs.runCommand "lock-shape" { } "touch $out";

  # --- What the fixtures build ----------------------------------------------

  # The app runs from its deployed tree, with its workspace dependency and
  # its registry dependency resolved.
  workspace-app = pkgs.runCommand "workspace-app" { } ''
    out_text=$(${app.artifacts.bin.example-app} Nix)
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
      project = (build { src = ./fixtures/sources; }).packages.sources;
    in
    pkgs.runCommand "sources" { } ''
      out_text=$(${project.artifacts.bin.sources})
      echo "$out_text"
      grep -Fx 'github: a\.b' <<<"$out_text"
      grep -Fx 'git+https github: true' <<<"$out_text"
      grep -Fx 'tarball url: true' <<<"$out_text"
      grep -Fx 'git: 3600000' <<<"$out_text"
      grep -Fx 'directory: vendored' <<<"$out_text"
      grep -Fx 'tarball file: packed' <<<"$out_text"
      touch $out
    '';

  # A git dependency in a directory of its repository, whose prepare script
  # needs a devDependency (tests/fixtures/prepare, which installs
  # tests/fixtures/prepare-dep from this repository's history). pnpm
  # prepares it with npm, which resolves the devDependency from registry
  # metadata; the lock holds that metadata as an inline entry.
  prepare =
    let
      project = (build { src = ./fixtures/prepare; }).packages.prepare;
    in
    pkgs.runCommand "prepare" { } ''
      out_text=$(${project.artifacts.bin.prepare-check})
      echo "$out_text"
      grep -Fx 'prepared, picocolors function' <<<"$out_text"
      touch $out
    '';

  # A real project, pinned: unjs/giget, a command-line tool on pnpm 11 with
  # a few hundred locked packages, at commit f1dad45. Its source is fetched
  # during evaluation by its hash. Its pnpm-lock.yaml says everything the
  # build needs, so `pnpm-purifier lock` writes no purifier lockfile for it.
  # The build runs its obuild build in the sandbox, and the check runs the
  # command it builds.
  real-world =
    let
      src = builtins.fetchTree {
        type = "github";
        owner = "unjs";
        repo = "giget";
        rev = "f1dad453055b97a81d5227edce7262c8dcaf53d2";
        narHash = "sha256-hDKGYxozIV8UQTbPpJVs6jrDiPmcHK2EWRZ7WNfSYQ0=";
      };
      project = (build { inherit src; }).packages.giget;
    in
    pkgs.runCommand "real-world" { } ''
      ${project.artifacts.bin.giget} --help | tee help
      grep -F 'giget v3.3.1' help
      touch $out
    '';

  # The release holds the tarball of each project that is not private, which
  # `pnpm-purifier publish` uploads with `pnpm publish`. The check publishes
  # the release to a registry on the loopback interface
  # (tests/fake-registry.mjs) and compares what the registry received with
  # the file Nix built.
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
        [ "$(ls ${workspace.release})" = example-greet-1.0.0.tgz ]
        node ${./fake-registry.mjs} "$TMPDIR/port" "$TMPDIR/published.tgz" &
        # Darwin builds have no PID namespace, so a registry left running
        # would keep the build's log open after the builder exits.
        server=$!
        trap 'kill $server' EXIT
        while [ ! -s "$TMPDIR/port" ]; do sleep 0.1; done
        port=$(cat "$TMPDIR/port")
        echo "//127.0.0.1:$port/:_authToken=check" > "$HOME/.npmrc"
        tarball=${workspace.release}/example-greet-1.0.0.tgz
        pnpm publish "$tarball" --registry "http://127.0.0.1:$port/" --no-git-checks
        cmp "$tarball" "$TMPDIR/published.tgz"
        touch $out
      '';

  # A library that is not private gets the tarball `pnpm pack` makes.
  workspace-greet-tarball = pkgs.runCommand "workspace-greet-tarball" { } ''
    tarball=${greet.artifacts.tarball}
    ${lib.getExe pkgs.gnutar} -xzf "$tarball" -O package/package.json | grep -F '"name": "@example/greet"'
    # greet's build script runs by its path, with a #!/usr/bin/env node
    # shebang, which the sandbox has no /usr/bin/env for.
    ${lib.getExe pkgs.gnutar} -xzf "$tarball" -O package/built.txt | grep -Fx 'built by gen.js'
    touch $out
  '';

  # A build reads the native packages of its own system only. The lock
  # holds esbuild's binary package for each system it covers, with the one
  # system it is for in `systems`, and the manifest of the host system
  # holds that system's one. `fetches` lists the entries of every system
  # for SBOM and license tools.
  platform-filters =
    let
      own =
        {
          x86_64-linux = "linux-x64";
          aarch64-linux = "linux-arm64";
          aarch64-darwin = "darwin-arm64";
        }
        .${pkgs.stdenv.hostPlatform.system};
      esbuildFetches = builtins.filter (e: lib.hasInfix "/@esbuild/" e.path) workspace.fetches;
      platformOf = e: builtins.elemAt (builtins.match ".*/@esbuild/([^/]+)/.*" e.path) 0;
    in
    assert
      builtins.listToAttrs (
        map (e: {
          name = platformOf e;
          value = e.systems;
        }) esbuildFetches
      ) == {
        linux-x64 = [ "x86_64-linux" ];
        linux-arm64 = [ "aarch64-linux" ];
        darwin-arm64 = [ "aarch64-darwin" ];
      };
    pkgs.runCommand "platform-filters" { nativeBuildInputs = [ pkgs.jq ]; } ''
      jq -r 'keys[] | select(contains("/@esbuild/"))' ${workspace.dependencies} > esbuild
      cat esbuild
      [ "$(cat esbuild)" = "https/registry.npmjs.org/@esbuild/${own}/-/${own}-0.25.12.tgz" ]
      touch $out
    '';

  # The outputs of each project are known during evaluation, before a
  # build: the bin wrappers by name, and the tarball of a project that is
  # not private.
  artifact-names =
    assert builtins.attrNames app.artifacts == [ "bin" ];
    assert builtins.attrNames app.artifacts.bin == [ "example-app" ];
    assert lib.hasSuffix "/example-greet-1.0.0.tgz" greet.artifacts.tarball;
    assert greet.artifacts.bin == { };
    assert
      builtins.attrNames workspace.packages == [
        "@example/app"
        "@example/greet"
        "workspace-root"
      ];
    pkgs.runCommand "artifact-names" { } "touch $out";

  # The purifier lockfile of the prepare fixture holds an inline entry: the
  # registry metadata that npm reads offline when pnpm prepares the git
  # dependency. The manifest serves the entry from a file with its
  # contents.
  inline-entry =
    let
      inherit (build { src = ./fixtures/prepare; }) dependencies;
    in
    pkgs.runCommand "inline-entry" { nativeBuildInputs = [ pkgs.jq ]; } ''
      file=$(jq -r '."https/registry.npmjs.org/picocolors"' ${dependencies})
      jq -e '.versions."1.1.0".dist.tarball' "$file"
      tarball=$(jq -r '."https/registry.npmjs.org/picocolors/-/picocolors-1.1.0.tgz"' ${dependencies})
      ${lib.getExe pkgs.gnutar} -xzf "$tarball" -O package/package.json | jq -e '.version == "1.1.0"'
      touch $out
    '';

  # The unit tests of src/lib.mjs (tests/unit/), which read the fixture
  # lockfiles.
  unit = pkgs.runCommand "unit" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    mkdir -p repo/tests
    cp -r ${../src} repo/src
    cp -r ${./unit} repo/tests/unit
    cp -r ${./fixtures} repo/tests/fixtures
    node --test repo/tests/unit/lib.test.mjs
    touch $out
  '';

  # A lock whose entry for the picocolors tarball, which the prepare step
  # of the git dependency reads, names the file of ms, with a contentHash
  # that matches. Nix fetches that file, its hash being right for it, and
  # the install refuses it, because it does not match the integrity of the
  # registry metadata.
  integrity =
    let
      failure =
        pkgs.testers.testBuildFailure
          (build {
            src = ./fixtures/prepare;
            lockFile = ./fixtures/negative/swapped-file.lock.json;
          }).packages.prepare;
    in
    pkgs.runCommand "integrity" { } ''
      grep -i 'integrity' ${failure}/testBuildFailure.log
      touch $out
    '';
}
