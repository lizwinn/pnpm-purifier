# buildPnpmProject: the sandboxed builds of a pnpm project, from the
# lockfile `pnpm-purifier lock` writes beside pnpm-lock.yaml.
#
# The file is a package for callPackage: the first argument set is what it
# takes from the package set, and the result is the builder. The
# pnpm-purifier overlay (`overlays.default`) adds it to the package set as
# `buildPnpmProject`, so a package written for callPackage takes it like
# any other dependency:
#
#   { buildPnpmProject }: (buildPnpmProject { src = ./.; }).packages."@example/app"
#
# The builder returns
#
#   dependencies       the manifest of every locked download, which the
#                      local registry serves from
#   packages.<name>    workspace project <name>, built and deployed with its
#                      production dependencies under lib/node_modules/<name>,
#                      with a wrapper in bin/ for each of its `bin` entries;
#                      a project that is not private also has a `tarball`
#                      output holding what `pnpm pack` makes of it
#   packages.<name>.artifacts
#                      the files of those outputs by name, known during
#                      evaluation: `bin.<bin>` and `tarball`
{
  lib,
  stdenv,
  callPackage,
  makeWrapper,
  nodejs,
  # pnpm of each major version the lock may have been made with. The build
  # runs the one of the lock's major version; nixpkgs builds each from
  # source, which pnpm 12 (a native program) needs.
  pnpm_10 ? null,
  pnpm_11 ? null,
  pnpm_12 ? null,
  # The purifier library (`lib.purifier` of github:nix-purifiers/purifier),
  # which the pnpm-purifier overlay passes.
  purifier,
}:
{
  # The root of the pnpm workspace or project, which holds pnpm-lock.yaml.
  src,
  # The lockfile; the default is the one `pnpm-purifier lock` writes.
  lockFile ? src + "/pnpm-purifier.lock.json",
  # The pnpm that runs the build. The default is pnpm of the major version
  # the lock was made with.
  pnpm ? null,
  # Replaces nixpkgs' fetchurl for the locked files, such as a fetchurl
  # that sends credentials; see dependencies.nix.
  fetchurl ? null,
  # The package script each package build runs after installing, in the
  # project and in the workspace projects it depends on, when they have it.
  buildScript ? "build",
  # Runs each project's `test` script in its package build.
  doCheck ? false,
  # Packages that lifecycle and build scripts need, such as python3 and a
  # C compiler for native addons.
  nativeBuildInputs ? [ ],
  # Filters the project root before it is copied into the store, as the
  # `filter` of builtins.path. The default leaves out node_modules and
  # editor state.
  srcFilter ? null,
}:
let
  lock = import ./lock.nix { inherit lockFile; };

  pnpmMajor = builtins.head (lib.splitString "." lock.pnpmVersion);
  pnpmByMajor = lib.filterAttrs (_: p: p != null) {
    "10" = pnpm_10;
    "11" = pnpm_11;
    "12" = pnpm_12;
  };
  pnpm' =
    if pnpm != null then
      pnpm
    else
      pnpmByMajor.${pnpmMajor}
        or (throw "pnpm-purifier: the package set has no pnpm ${pnpmMajor} for the pnpm ${lock.pnpmVersion} the lock was made with; pass `pnpm`.");

  # The lock holds the downloads of one pnpm-lock.yaml; a build of another
  # would fail on its first missing download.
  pnpmLockHash = builtins.hashFile "sha256" (src + "/pnpm-lock.yaml");
  freshLock =
    pnpmLockHash == lock.pnpmLockHash
    || throw "pnpm-purifier: ${toString src}/pnpm-lock.yaml changed since ${toString lockFile} was written; run `pnpm-purifier lock`.";

  defaultSrcFilter =
    path: type:
    let
      name = baseNameOf path;
    in
    !(
      (type == "directory" && (name == "node_modules" || name == ".pnpm-purifier"))
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

  dependencies = callPackage ./dependencies.nix (
    { inherit lockFile purifier; } // lib.optionalAttrs (fetchurl != null) { inherit fetchurl; }
  );

  # The command-line program with the module it imports.
  cli = "${../../src}/pnpm-purifier.mjs";

  # A derivation name from a package name: @example/app becomes example-app.
  derivationName = name: lib.replaceStrings [ "/" ] [ "-" ] (lib.removePrefix "@" name);

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
      filterWithDeps = lib.escapeShellArg "${project.name}...";
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
    assert freshLock;
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

      # The steps run as one command under the local registry, which serves
      # the locked downloads and nothing else.
      buildPhase = ''
        runHook preBuild
        export HOME="$TMPDIR/home"
        export XDG_RUNTIME_DIR="$TMPDIR/run"
        export XDG_CACHE_HOME="$HOME/.cache" XDG_CONFIG_HOME="$HOME/.config"
        export XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"
        # node-gyp builds native addons against these headers rather than
        # downloading them.
        export npm_config_nodedir=${nodejs}
        mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
        # The sandbox has no /usr/bin/env, so a script that runs by its path
        # needs its shebang to name an interpreter in the store: the
        # project's own scripts before anything runs, and the scripts of
        # the installed packages after the install.
        patchShebangs --build .
        node ${cli} registry-exec --manifest ${dependencies} --lock ${lockFile} --pin-project . -- \
          pnpm install --frozen-lockfile --store-dir "$TMPDIR/store" --filter ${filterWithDeps}
        for modules in $(find . -name node_modules -type d -prune); do
          patchShebangs --build "$modules"
        done
        node ${cli} registry-exec --manifest ${dependencies} --lock ${lockFile} --pin-project . -- \
          bash -euo pipefail -c '
            pnpm --filter ${filterWithDeps} run --if-present ${lib.escapeShellArg buildScript}
            ${lib.optionalString doCheck "pnpm --filter ${filter} run --if-present test"}
            ${lib.optionalString (!isPrivate) ''
              mkdir -p "$TMPDIR/pack"
              pnpm --filter ${filter} pack --pack-destination "$TMPDIR/pack"
            ''}
            ${deploy}
          '
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p "$(dirname "${deployed}")"
        cp -r ${if atRoot then "." else ''"$TMPDIR/deploy"''} "${deployed}"
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
        inherit dependencies lock;
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
        };
      };
      meta = {
        description = "${project.name}, built by pnpm-purifier";
      }
      // lib.optionalAttrs (bins != { }) { mainProgram = builtins.head (builtins.attrNames bins); };
    });
in
{
  inherit lock dependencies;
  packages = builtins.mapAttrs (_: mkPackage) lock.projectsByName;
  pnpm = pnpm';
}
