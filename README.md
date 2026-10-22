# A&S RTX Patcher — Patch Library

Patch catalogue and `.vcdiff` assets for the
[Actions & Stuff RTX Patcher](https://github.com/Felix-Chaos/Actions-and-Stuff-RTX-Patcher).

This repo is **deliberately separate** from the patcher repo. Patches are published here; app updates
are released there. The two never interact — this repo has no app releases, no version tags, and no
updater manifest.

## To publish a patch

```bash
cp -r "<new patch folder>" Patches/
git add Patches && git commit -m "Publish <pack> v<patch>" && git push
```

That is all. CI does the rest, and the patch is live for every installed copy of the patcher within a
minute — no app update, no installer, no version bump.

## To retire a patch

```bash
git rm -r "Patches/<folder>" && git commit -m "Retire <folder>" && git push
```

CI regenerates the catalogue and deletes the orphaned release assets.

## How it works

`Patches/` is the single source of truth. Everything else is derived from it.

```
Patches/
  Actions & Stuff for RTX 1.11.1 V0.1/
    encrypted.vcdiff      applied to a Marketplace (premium cache) pack
    decrypted.vcdiff      applied to an extracted / zip pack
    patch_config.json     pack + patch version, expected file counts, logo hash
```

### Beta patches

Each catalogue entry has a `beta` field. A patch is beta when its `patch_config.json` has
`"beta": true`. Without that field, a `0.x` patch version counts as beta and `1.0` and up as a
release. Set `"beta": false` to release a `0.x` patch early, or `"beta": true` to hold back a `1.x`
one. To promote a beta, change the field and push: the catalogue updates without re-uploading the
patch. The website and the Discord bot show and announce patches by this field.

### Hotpatches

A hotpatch is a patch for a new A&S version made from the RTX patch of an older one, so content new
in that A&S version may not have RTX materials yet. Mark it in `patch_config.json` with
`"hotpatch": true` and, optionally, `"basedOn": "v1.11.1"` (the A&S version the RTX work comes from).
The patcher's Create Patch tool writes both when its Hotpatch toggle is on. The catalogue carries
`hotpatch` and `basedOn` on every entry; the patcher, website and Discord bot label it as a hotpatch.

On every push touching `Patches/`, [`publish-patches.yml`](.github/workflows/publish-patches.yml):

1. computes SHA-256 and size for each `.vcdiff`,
2. uploads new or changed ones to the `patch-library` release as `<slug>-<variant>.vcdiff`,
3. deletes release assets no longer backed by a folder,
4. regenerates and uploads [`patch_index.json`](patch_index.json),
5. commits the regenerated catalogue back.

The manifest is uploaded **last**, so a patcher fetching mid-run never sees a catalogue pointing at an
asset that has not landed yet.

The `patch-library` release is not a version of anything — it is a permanent asset store, created once.
GitHub release assets are used because they are built for binary distribution, unlike
`raw.githubusercontent.com`. The patcher reads:

```
https://github.com/Felix-Chaos/AS-RTX-Patch-Library/releases/download/patch-library/patch_index.json
```

Files are renamed to `<slug>-<variant>.vcdiff` on upload because every folder's files share the literal
names `encrypted.vcdiff` / `decrypted.vcdiff`, and release assets share one flat namespace. The slug is
derived from the pack and patch version, e.g. `v1.11.1` + `0.1` becomes `as-1-11-1-p0-1`.

## Local commands

```bash
node scripts/generate-patch-index.mjs            # regenerate the catalogue
node scripts/generate-patch-index.mjs --check    # verify the catalogue against the folders
```

`patch_index.json` is generated — never edit it by hand.

## Licence

The `.vcdiff` files are binary deltas. They contain no original pack assets and are useless without a
legitimately owned copy of the Actions & Stuff pack.
