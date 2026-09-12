# Clean-machine install smoke

Proves the claim a published package set exists to make: **a stranger on a clean
machine can install the current release from the public registries and get the
same canonical wire bytes out of either host.**

It deliberately shares nothing with this workspace. The TypeScript leg installs
`@fuaran-ui/*` from npm into a throwaway project; the F# leg restores `Fuaran.UI`
from nuget.org into a throwaway console app, with a `nuget.config` that clears
every other source first. Neither leg can see a workspace link, a local folder
feed, or a build output — which is the only way this check can mean what it says.

Both legs author the SAME tree through each tier's own ergonomic surface and
print `encodeNode` of it. The two strings must be byte-identical.

The tree is small and deliberately chosen: a dashboard wrapper (a convenience
constructor that injects an accessibility default the wire then carries), a
heading (a required enum that defaults and is still emitted), and a metric (a
bound numeric value, a discriminated format, a tone). Between them they exercise
nesting, member ordering, default omission, `$type` discrimination and numeric
spelling — the four places two independent encoders drift first.

## Running it by hand

```
cd ts && npm install --no-audit --no-fund && node smoke.mjs
cd ../fs && dotnet run
```

## Unpinned, on purpose

Both legs float to the CURRENT published version. The claim is about the pair a
newcomer actually gets today; a pinned pair would drift apart and keep reporting
green about a release nobody installs. It is the same posture the cross-host
parity lane in `ci.yml` takes for the same reason.
