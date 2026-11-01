# pnpm-purifier

A command-line program and Nix library that let Nix build a pnpm project in
its sandbox. pnpm-purifier records the files pnpm downloads for a project
in a lockfile, `pnpm-purifier.lock.json`, beside `pnpm-lock.yaml`. Nix
builds the project from that lockfile, so the project needs no generated
Nix files. It is one of the [nix-purifiers](https://nix-purifiers.github.io).

- **A lockfile.** `pnpm-purifier lock` installs the project once from
  `pnpm-lock.yaml`, with an empty store, and records every package tarball
  pnpm downloads by URL and SHA-256. It installs the platform-specific
  packages of Linux and macOS on x86-64 and ARM64 too, so one lockfile
  serves each of those systems. The lockfile also names the pnpm version,
  the registries and the workspace projects.
- **Sandboxed builds.** `buildPnpmProject`, which the flake's overlay adds
  to a package set, builds each workspace project: it installs from the
  locked tarballs, runs the project's `build` script, and deploys the
  project with its production dependencies. Each `bin` entry gets a
  wrapper, and a project that is not private also gets the tarball that
  `pnpm pack` makes.
- **Interactive pnpm on the locked downloads.** `pnpm-purifier <pnpm
  arguments>` runs pnpm with the locked tarballs, which Nix fetches,
  and no network.

## How it works

pnpm reads every package through a registry on the loopback interface that
pnpm-purifier runs. During the lock run the registry forwards each request
upstream and records what it returns. In the Nix build and in interactive
mode it serves the locked files from the Nix store, and nothing else. The
registry mirrors upstream URLs, so
`https://registry.npmjs.org/ms/-/ms-2.1.3.tgz` is
`https/registry.npmjs.org/ms/-/ms-2.1.3.tgz` on it, which is also the
file's `path` in the lockfile.

The lock holds the downloads of one `pnpm-lock.yaml`. pnpm-purifier records
the hash of `pnpm-lock.yaml` in the lock, and the Nix build fails at
evaluation when they no longer match. Interactive mode then runs pnpm
online until the next `pnpm-purifier lock`.

pnpm 12 checks `pnpm-lock.yaml` against its supply-chain policies with
registry metadata and attestations, which change over time and cannot be
locked by hash. The lock run makes that check online, and the offline
modes run pnpm with `trust-lockfile`.

## Use

In the project root, after `pnpm install` has written `pnpm-lock.yaml`:

```zsh
nix run github:nix-purifiers/pnpm-purifier -- lock
```

Commit `pnpm-purifier.lock.json`. The flake's `overlays.default` adds
`buildPnpmProject` to a package set:

```nix
# package.nix
{ buildPnpmProject }:
(buildPnpmProject { src = ./.; }).packages."@example/app"
```

```nix
{
  inputs.pnpm-purifier.url = "github:nix-purifiers/pnpm-purifier";
  inputs.nixpkgs.follows = "pnpm-purifier/nixpkgs";

  outputs = { nixpkgs, pnpm-purifier, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [
          pnpm-purifier.overlays.default
          (final: prev: { example-app = final.callPackage ./package.nix { }; })
        ];
      };
    in
    {
      packages.${system}.example-app = pkgs.example-app;
    };
}
```

`nix/lib/build-pnpm-project.nix` documents the builder's arguments:
`pnpm` (the default is nixpkgs' pnpm of the major version the lock was
made with), `fetchurl` (for credentials or mirrors), `buildScript`,
`doCheck` (runs the `test` script), `nativeBuildInputs` (for native
addons) and `srcFilter`. Native addons build against the headers of the
build's Node.js, which pnpm-purifier names in `npm_config_nodedir`.

The `pnpm-purifier` command runs the pnpm of the major version that the
project's `packageManager` field names, from the flake's nixpkgs (pnpm 10,
11 or 12). `PNPM_PURIFIER_PNPM` names another pnpm, and
`PNPM_PURIFIER=0` turns interactive mode off.

## Limitations

- The lock run refuses git dependencies and dependencies given by tarball
  URL, which pnpm fetches without the registry.
- The lock run forwards to registries without credentials. A private
  registry needs a `fetchurl` with credentials for the Nix build, and the
  lock run does not yet send any.
- Registry metadata is never locked, and interactive mode does not serve
  it. A command that resolves versions, such as `pnpm add`, reads registry
  metadata, so it runs with `PNPM_PURIFIER=0`, followed by
  `pnpm-purifier lock`.
- The flake's checks run on x86_64-linux and aarch64-linux.
