# The fetcher for locked artifacts.
#
# By default each artifact is a fixed-output derivation on Nix's built-in
# fetcher (the same derivation <nix/fetchurl.nix> makes), so neither the
# interactive mode nor a sandboxed build needs nixpkgs to download. A
# fixed-output store path depends only on its name and hash, so the
# default fetcher and nixpkgs' fetchurl produce the same paths.
#
# `fetchurl`, when given, replaces the built-in fetcher. It is called with
# { name, urls, hash }, where `urls` is the artifact's URL followed by its
# mirrors, and is the place for credentials (nixpkgs' fetchurl takes
# `netrcPhase`).
{
  lock,
  fetchurl ? null,
}:
artifact:
let
  name = lock.artifactName artifact;
  urls = [ artifact.url ] ++ artifact.mirrors;
in
if fetchurl != null then
  fetchurl {
    inherit name urls;
    inherit (artifact) hash;
  }
else
  derivation {
    inherit name urls;
    builder = "builtin:fetchurl";
    system = "builtin";
    inherit (artifact) url;
    outputHash = artifact.hash;
    outputHashAlgo = "sha256";
    outputHashMode = "flat";
    unpack = false;
    executable = false;
    preferLocalBuild = true;
    impureEnvVars = [
      "http_proxy"
      "https_proxy"
      "ftp_proxy"
      "all_proxy"
      "no_proxy"
    ];
  }
