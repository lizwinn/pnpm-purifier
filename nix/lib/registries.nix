# The registries a project resolves from: the default registry and one per
# scope, as the project's .npmrc sets them (`registry=URL` and
# `@scope:registry=URL`), over npm's default registry and pnpm's default
# for the @jsr scope. `override`, the `registries` of the purifier
# lockfile, replaces them all: the lock run records it when the user
# config sets registries that the project's .npmrc does not. src/lib.mjs
# reads .npmrc the same way.
#
# Needs no nixpkgs.
{
  npmrcText ? "",
  override ? null,
}:
let
  inherit (builtins)
    filter
    isString
    split
    match
    elemAt
    foldl'
    length
    substring
    stringLength
    ;
  lines = filter isString (split "\n" npmrcText);
  withSlash = url: if substring (stringLength url - 1) 1 url == "/" then url else url + "/";
  scoped = filter (m: m != null) (
    map (match "[ \t]*(@[^:= \t]+):registry[ \t]*=[ \t]*([^ \t]+)[ \t]*") lines
  );
  defaults = filter (m: m != null) (map (match "[ \t]*registry[ \t]*=[ \t]*([^ \t]+)[ \t]*") lines);
in
if override != null then
  override
else
  {
    # As in an ini file, a later line wins over an earlier one.
    default =
      if defaults == [ ] then
        "https://registry.npmjs.org/"
      else
        withSlash (elemAt (elemAt defaults (length defaults - 1)) 0);
    scopes = foldl' (acc: m: acc // { ${elemAt m 0} = withSlash (elemAt m 1); }) {
      "@jsr" = "https://npm.jsr.io/";
    } scoped;
  }
