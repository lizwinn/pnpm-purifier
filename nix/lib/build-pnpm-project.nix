# buildPnpmProject: the sandboxed builds of a pnpm project, from its
# pnpm-lock.yaml and, when the project has one, the purifier lockfile
# `pnpm-purifier lock` writes beside it.
#
# It is a package for callPackage in the scope `pkgs.pnpm-purifier`, which
# the flake's `overlays.default` adds to the package set, with the purifier
# library (`lib.purifier` of github:nix-purifiers/purifier) as `purifier`.
# `pnpm-purifier.buildPnpmProject.override` replaces any package it takes,
# and `pnpm-purifier.overrideScope` replaces what the scope shares. A
# package takes the scope by name:
#
#   { pnpm-purifier }:
#   (pnpm-purifier.buildPnpmProject { src = ./.; }).packages."@example/app"
#
# The builder returns
#
#   packages.<name>    workspace project <name>, built and deployed with its
#                      production dependencies under lib/node_modules/<name>,
#                      with a wrapper in bin/ for each of its `bin` entries;
#                      a project that is not private also has a `tarball`
#                      output holding what `pnpm pack` makes of it
#   packages.<name>.artifacts
#                      the files of those outputs by name, known during
#                      evaluation: `bin.<bin>` and `tarball`
#   tests              the `test` script of every project, run in the
#                      sandbox
#   release            the tarballs of the projects that are not private,
#                      which `pnpm-purifier publish` uploads
#   fetches            the entries of the lock (`readLock`), for every
#                      system the lock covers
#   dependencies       the manifest of the entries for the host system,
#                      which the local registry serves from
#   lock               the lock in memory, as `readLock` gives it
scope@{
  # The pnpm packages, of which the builder takes the one of the major
  # version the project uses, and `pnpm` when nothing names a version.
  pnpm,
  pnpm_10 ? null,
  pnpm_11 ? null,
  pnpm_12 ? null,
  lib,
  stdenv,
  makeWrapper,
  nodejs,
  linkFarm,
  runCommand,
  python3,
  nix,
  writeText,
  callPackage,
  purifier,
}:
{
  # The root of the pnpm workspace or project, which holds pnpm-lock.yaml.
  src,
  # Fetchers for the purifier library's fetchEntry, by name, such as a
  # `fetchurl` for a mirror or for credentials.
  fetchers ? { },
  dependencies ? purifier.lockedProjectInputs {
    inputs =
      if builtins.pathExists lockFile then (lib.importJSON lockFile).projectInputs or [ ] else [ ];
    system = stdenv.hostPlatform.system;
  },
  # The purifier lockfile; the default is the one `pnpm-purifier lock`
  # writes in the project, and a project without one builds from
  # pnpm-lock.yaml alone. A packaging flake keeps it outside `src` for a
  # project whose author does not.
  lockFile ? src + "/pnpm-purifier.lock.json",
  # pnpm-lock.yaml; the default is the copy in `src`. An external build can
  # pass a copy kept outside the repository, which the build uses in place
  # of the one in `src`.
  pnpmLock ? src + "/pnpm-lock.yaml",
  # The pnpm that runs the build. The default is the package set's pnpm of
  # the major version (pnpm_10, pnpm_11 or pnpm_12) that the
  # `packageManager` field of package.json names, or that the purifier
  # lockfile records, which nixpkgs builds from source.
  pnpm ? null,
  # The package script each package build runs after installing, in the
  # project and in the workspace projects it depends on, when they have it.
  buildScript ? "build",
  # Packages that lifecycle and build scripts need, such as python3 and a
  # C compiler for native addons.
  nativeBuildInputs ? [ ],
  # Filters the project root before it is copied into the store, as the
  # `filter` of builtins.path. The default leaves out node_modules and
  # editor state.
  srcFilter ? null,
}:
let
  inputSelection = purifier.npmInputSelection { inherit dependencies; };
  selectedInputs = inputSelection.inputs;
  inputViews = writeText "pnpm-input-views.json" (builtins.toJSON inputSelection.views);

  # The lock in memory (read-lock.nix), which fails evaluation through the
  # library's checkLock when the lockfiles cannot be used.
  readLock = import ./read-lock.nix { inherit purifier; };
  lock = purifier.checkLock (readLock {
    providedNames = inputSelection.names;
    providedVersions = inputSelection.versions;
    inherit src lockFile pnpmLock;
  });

  pnpmVersion = lock.pnpm.version;
  pnpm' =
    if pnpm != null then
      pnpm
    else if pnpmVersion == null then
      scope.pnpm
    else
      let
        major = builtins.head (lib.splitString "." pnpmVersion);
        available = scope."pnpm_${major}" or null;
      in
      if available != null then
        available
      else
        throw "pnpm-purifier: this package set has no pnpm_${major} for the pnpm ${pnpmVersion} the project uses; pass `pnpm`.";

  inherit (lock.pnpm) registries;
  registriesFile = writeText "pnpm-purifier-registries.json" (builtins.toJSON registries);

  # The workspace projects by package name.
  projects = lock.outputs;

  defaultSrcFilter =
    path: type:
    let
      name = baseNameOf path;
    in
    !(
      (type == "directory" && (name == "node_modules" || name == ".pnpm-purifier"))
      # The purifier lockfile goes to the build as `lockFile`.
      || name == "pnpm-purifier.lock.json"
      || name == ".git"
      || name == ".idea"
      || name == ".vscode"
      || lib.hasPrefix "result" name
    );

  filteredSrc = builtins.path {
    path = src;
    name = "pnpm-source";
    filter = if srcFilter != null then srcFilter else defaultSrcFilter;
  };

  lockedDependencies = callPackage ./dependencies.nix {
    entries = purifier.entriesFor stdenv.hostPlatform.system lock;
    inherit purifier fetchers;
  };

  # The command-line program with the module it imports.
  cli = "${../../src}/pnpm-purifier.mjs";

  # A derivation name from a package name: @example/app becomes example-app.
  derivationName = name: lib.replaceStrings [ "/" ] [ "-" ] (lib.removePrefix "@" name);

  # The shell that installs the project from the locked files, under the
  # local registry, which serves them and nothing else, then runs
  # `commands` under it too. `filter` limits the install to some projects.
  # The sandbox has no /usr/bin/env, so a script that runs by its path
  # needs its shebang to name an interpreter in the store: the project's
  # own scripts are patched before anything runs, and the scripts of the
  # installed packages after the install.
  installAndRun =
    {
      filter ? null,
      commands,
    }:
    let
      registry = "node ${cli} registry-exec --manifest ${lockedDependencies} --registries ${registriesFile} --pin-project . --";
      filterArgs = lib.optionalString (filter != null) "--filter ${lib.escapeShellArg filter}";
    in
    ''
      export HOME="$TMPDIR/home"
      export XDG_RUNTIME_DIR="$TMPDIR/run"
      export XDG_CACHE_HOME="$HOME/.cache" XDG_CONFIG_HOME="$HOME/.config"
      export XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"
      # node-gyp builds native addons against these headers rather than
      # downloading them.
      export npm_config_nodedir=${nodejs}
      ${lib.optionalString (dependencies != [ ]) ''
        export PNPM_PURIFIER_INPUT_VIEWS=${inputViews}
        export pnpm_config_global_pnpmfile=${../../src/npm-inputs.cjs}
        export npm_config_global_pnpmfile=${../../src/npm-inputs.cjs}
      ''}
      mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
      cp --no-preserve=mode ${pnpmLock} pnpm-lock.yaml
      node ${../../src/npm-input-lock.mjs} pnpm-lock.yaml
      patchShebangs --build .
      ${registry} pnpm install --frozen-lockfile --store-dir "$TMPDIR/store" ${filterArgs}
      for modules in $(find . -name node_modules -type d -prune); do
        patchShebangs --build "$modules"
      done
      ${registry} bash -euo pipefail -c ${lib.escapeShellArg commands}
    '';

  # pnpm writes state files with times and with the local registry's port
  # into node_modules. Nothing reads them at run time, and they would make
  # each build differ from the last. `pnpm deploy` also writes the
  # dependency maps of the deployed package.json in no fixed order, so they
  # are sorted.
  removeInstallState = dir: ''
    find ${dir} \( -name .modules.yaml -o -name '.pnpm-workspace-state*.json' -o -path '*/node_modules/.pnpm/lock.yaml' \) -delete
    node -e '
      const fs = require("node:fs");
      const file = process.argv[1];
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        if (manifest[key]) manifest[key] = Object.fromEntries(Object.entries(manifest[key]).sort(([a], [b]) => (a < b ? -1 : 1)));
      }
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
    ' ${dir}/package.json
  '';

  # `pnpm deploy` names each workspace dependency by its absolute path, in
  # the build directory: in package.json and pnpm-lock.yaml and, with "+"
  # for "/", in its directory under node_modules/.pnpm and the links to it.
  # Linux builds always run in /build, but darwin builds run in a new
  # directory each time, so the build directory is written as /build there
  # too.
  rewriteBuildDir = dir: ''
    top=$(cd "$NIX_BUILD_TOP" && pwd -P)
    if [ "$top" != /build ]; then
      encoded=''${top//\//+}
      for entry in ${dir}/node_modules/.pnpm/*"$encoded"*; do
        if [ -e "$entry" ]; then mv "$entry" "''${entry//"$encoded"/+build}"; fi
      done
      find ${dir} -type l | while read -r link; do
        target=$(readlink "$link")
        case $target in
          *"$encoded"*) ln -sfn "''${target//"$encoded"/+build}" "$link" ;;
        esac
      done
      { grep -rlIF "$top" ${dir} || true; } | while read -r file; do
        sed -i "s|$top|/build|g" "$file"
      done
    fi
  '';

  mkPackage =
    project:
    let
      manifest = lib.importJSON (src + "/${project.path}/package.json");
      isPrivate = manifest.private or false;
      # The `bin` field is a path, which names the bin after the package,
      # or an object from bin names to paths.
      bins =
        if manifest ? bin && builtins.isString manifest.bin then
          { ${lib.last (lib.splitString "/" project.name)} = manifest.bin; }
        else
          manifest.bin or { };
      deployed = "$out/lib/node_modules/${project.name}";
      # The file `pnpm pack` writes: the package name without its leading @
      # and with - for /, then the version.
      tarballName = "${derivationName project.name}-${manifest.version or "0"}.tgz";
      filter = lib.escapeShellArg project.name;
      # `pnpm deploy` copies a workspace project with its production
      # dependencies, and works only for a project inside a workspace. The
      # project at the root keeps its own directory, reinstalled without
      # its development dependencies.
      atRoot = project.path == ".";
      deploy =
        if atRoot then
          ''
            pnpm install --frozen-lockfile --prod --store-dir "$TMPDIR/store" --filter ${filter}
          ''
        else
          ''
            pnpm --filter ${filter} deploy --prod "$TMPDIR/deploy"
          '';
    in
    stdenv.mkDerivation (finalAttrs: {
      pname = derivationName project.name;
      version = manifest.version or "0";
      src = filteredSrc;
      outputs = [ "out" ] ++ lib.optional (!isPrivate) "tarball";
      nativeBuildInputs = [
        nodejs
        pnpm'
        makeWrapper
      ]
      ++ nativeBuildInputs;
      dontConfigure = true;

      buildPhase = ''
        runHook preBuild
        ${installAndRun {
          filter = "${project.name}...";
          commands = ''
            pnpm --filter ${lib.escapeShellArg "${project.name}..."} run --if-present ${lib.escapeShellArg buildScript}
            ${lib.optionalString (!isPrivate) ''
              mkdir -p "$TMPDIR/pack"
              pnpm --filter ${filter} pack --pack-destination "$TMPDIR/pack"
            ''}
            ${deploy}
          '';
        }}
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p "$(dirname "${deployed}")"
        cp -r ${if atRoot then "." else ''"$TMPDIR/deploy"''} "${deployed}"
        ${removeInstallState ''"${deployed}"''}
        ${rewriteBuildDir ''"${deployed}"''}
        ${lib.concatStrings (
          lib.mapAttrsToList (bin: file: ''
            makeWrapper ${lib.getExe nodejs} "$out/bin/${bin}" \
              --add-flags "${deployed}/${lib.removePrefix "./" file}"
          '') bins
        )}
        ${lib.optionalString (!isPrivate) ''
          mkdir -p "$tarball"
          cp "$TMPDIR/pack/${tarballName}" "$tarball/${tarballName}"
        ''}
        runHook postInstall
      '';

      passthru = {
        inherit lock;
        dependencies = lockedDependencies;
        projections = projectionFor [ project.name ];
        pnpmProject = project;
        # The outputs of the project, known from the lockfile and its
        # package.json before the package is built: `bin.<name>`, the
        # wrapper of each `bin` entry, and `tarball`, the file `pnpm pack`
        # makes of a project that is not private.
        artifacts = {
          bin = builtins.mapAttrs (bin: _: "${finalAttrs.finalPackage}/bin/${bin}") bins;
        }
        // lib.optionalAttrs (!isPrivate) {
          tarball = "${finalAttrs.finalPackage.tarball}/${tarballName}";
          inherit tarballName;
        };
      };
      meta = {
        description = "${project.name}, built by pnpm-purifier";
      }
      // lib.optionalAttrs (bins != { }) { mainProgram = builtins.head (builtins.attrNames bins); };
    });

  packages = builtins.mapAttrs (_: mkPackage) projects;

  rootName = derivationName (
    if builtins.pathExists (src + "/package.json") then
      (lib.importJSON (src + "/package.json")).name or "pnpm-project"
    else
      "pnpm-project"
  );

  # Every project's `test` script, after every project's build script, in
  # one install of the whole workspace.
  tests = stdenv.mkDerivation {
    name = "${rootName}-tests";
    src = filteredSrc;
    nativeBuildInputs = [
      nodejs
      pnpm'
    ]
    ++ nativeBuildInputs;
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      ${installAndRun {
        commands = ''
          pnpm --recursive run --if-present ${lib.escapeShellArg buildScript}
          pnpm --recursive run --if-present test
        '';
      }}
      runHook postBuild
    '';
    installPhase = "touch $out";
  };

  # The tarballs of the projects that are not private, by their file names.
  rawRelease = linkFarm "${rootName}-release" (
    lib.mapAttrsToList (_: p: {
      name = p.artifacts.tarballName;
      path = p.artifacts.tarball;
    }) (lib.filterAttrs (_: p: p.artifacts ? tarball) packages)
  );
  release = rawRelease.overrideAttrs (previous: {
    passthru = (previous.passthru or { }) // {
      inherit projections;
    };
  });
  capture = stdenv.mkDerivation {
    name = "${rootName}-runtime-graph";
    src = filteredSrc;
    nativeBuildInputs = [
      nodejs
      pnpm'
      nix
    ]
    ++ nativeBuildInputs;
    dontConfigure = true;
    buildPhase = installAndRun {
      commands = ''
        pnpm --include-workspace-root -r run --if-present ${lib.escapeShellArg buildScript}
      '';
    };
    installPhase = ''
      export NPM_PURIFIER_NPM_MODULES=${nodejs}/lib/node_modules/npm/node_modules
      export NPM_PROJECTION_NIX=${nix}/bin/nix
      mkdir -p "$TMPDIR/projection-archives"
      export PNPM_PROJECTION_ARCHIVES="$TMPDIR/projection-archives"
      node - ${
        writeText "pnpm-projection-packages.json" (
          builtins.toJSON (
            lib.mapAttrsToList
              (_: package: {
                name = package.pnpmProject.name;
                dir = package.pnpmProject.path;
                archive = if package.artifacts ? tarball then package.artifacts.tarball else null;
              })
              (
                lib.filterAttrs (
                  _: package:
                  let
                    manifest = lib.importJSON (src + "/${package.pnpmProject.path}/package.json");
                  in
                  package.artifacts ? tarball || manifest ? version || manifest ? bin
                ) packages
              )
          )
        )
      } "$TMPDIR/own-packages.json" <<'NODE'
      const fs = require('node:fs');
      const path = require('node:path');
      const { execFileSync } = require('node:child_process');
      const own = JSON.parse(fs.readFileSync(process.argv[2]));
      for (const [index, item] of own.entries()) {
        if (item.archive) continue;
        const destination = path.join(process.env.PNPM_PROJECTION_ARCHIVES, String(index));
        fs.mkdirSync(destination, {recursive:true});
        execFileSync('pnpm', ['--filter', item.name, 'pack', '--pack-destination', destination], {stdio:'inherit'});
        item.archive = path.join(destination, fs.readdirSync(destination).find(name=>name.endsWith('.tgz')));
      }
      fs.writeFileSync(process.argv[3], JSON.stringify(own));
      NODE
      node ${purifier.npmCaptureTool} "$PWD" ${release} "$out" "$TMPDIR/own-packages.json"
    '';
    dontFixup = true;
  };
  projectionFor =
    roots:
    purifier.npmProjections {
      graph = "${capture}/graph.json";
      archives = "${capture}/archives";
      producer = release;
      inherit
        roots
        dependencies
        runCommand
        python3
        ;
    };
  projections = projectionFor null;

in
{
  inherit
    lock
    registries
    registriesFile
    packages
    tests
    release
    projections
    ;
  dependencies = lockedDependencies;
  fetches = lock.entries;
  pnpm = pnpm';
}
