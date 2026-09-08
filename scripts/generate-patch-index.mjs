#!/usr/bin/env node
/**
 * Generates patch_index.json from the Patches/ folder set.
 *
 * The folder set is the single source of truth: add a folder to publish a
 * patch, `git rm` it to retire one. The manifest and the release assets are
 * both derived from it by CI (.github/workflows/publish-patches.yml).
 *
 *   node scripts/generate-patch-index.mjs [--assets-file <f>]
 *       Rewrite patch_index.json and stage into .release-staging/ only the
 *       .vcdiff pairs that are new or changed.
 *
 *   node scripts/generate-patch-index.mjs --check
 *       Verify the committed manifest against the folders. Read-only.
 *
 *   node scripts/generate-patch-index.mjs --list-orphans --assets-file <f>
 *       Print release-asset names no longer referenced by the manifest.
 *
 * --assets-file takes a file of release asset names, one per line, which CI
 * produces from the existing release. Without it the script cannot know what
 * is already uploaded, so it stages purely on manifest differences.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.PATCH_LIBRARY_REPO || "Felix-Chaos/AS-RTX-Patch-Library";
const TAG = process.env.PATCH_LIBRARY_TAG || "patch-library";
const ASSET_BASE = `https://github.com/${REPO}/releases/download/${TAG}`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATCHES_DIR = path.join(ROOT, "Patches");
const MANIFEST = path.join(ROOT, "patch_index.json");
const STAGING = path.join(ROOT, ".release-staging");
const VARIANTS = ["encrypted", "decrypted"];
const SCHEMA_VERSION = 1;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

/** Stable, ASCII-safe id: asset filename stem and local cache dir name. */
function makeSlug(packVersion, patchVersion) {
  const pack = String(packVersion).replace(/^v/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const patch = String(patchVersion).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `as-${pack}-p${patch}`;
}

/**
 * Mirrors the flattening get_patch_configs does in Rust (commands.rs:224-233).
 * resolvePatchConfig matches Auto-mode packs on the flattened `stats`, so a
 * remote entry without it would never match.
 */
function flattenStats(mp) {
  if (!mp || typeof mp !== "object") return null;
  if (mp.v1) return mp.v1;
  if (mp.stats) return mp.stats;
  return mp;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file, { highWaterMark: 1 << 16 })
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")));
  });
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Scan Patches/ and build one manifest entry per folder. */
async function buildEntries() {
  if (!(await exists(PATCHES_DIR))) die(`no Patches/ directory at ${PATCHES_DIR}`);
  const dirents = await fs.readdir(PATCHES_DIR, { withFileTypes: true });
  const entries = [];
  const seen = new Map();

  const dirs = dirents.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) {
    const folder = path.join(PATCHES_DIR, d.name);
    const configPath = path.join(folder, "patch_config.json");
    if (!(await exists(configPath))) {
      console.warn(`warn: skipping "${d.name}" - no patch_config.json`);
      continue;
    }

    const cfg = await readJson(configPath);
    if (!cfg.packVersion || !cfg.patchVersion) {
      die(`"${d.name}": patch_config.json is missing packVersion or patchVersion`);
    }

    const slug = makeSlug(cfg.packVersion, cfg.patchVersion);
    if (seen.has(slug)) {
      die(`slug collision "${slug}": "${d.name}" and "${seen.get(slug)}" resolve to the same id`);
    }
    seen.set(slug, d.name);

    const patches = {};
    for (const variant of VARIANTS) {
      const file = path.join(folder, `${variant}.vcdiff`);
      if (!(await exists(file))) die(`"${d.name}": missing ${variant}.vcdiff`);
      const { size } = await fs.stat(file);
      if (size === 0) die(`"${d.name}": ${variant}.vcdiff is empty`);
      patches[variant] = {
        url: `${ASSET_BASE}/${slug}-${variant}.vcdiff`,
        sha256: await sha256File(file),
        size,
      };
    }

    entries.push({
      slug,
      folder_name: d.name,
      packVersion: cfg.packVersion,
      patchVersion: cfg.patchVersion,
      marketplace_pack_stats: cfg.marketplace_pack_stats ?? null,
      stats: flattenStats(cfg.marketplace_pack_stats),
      validation: cfg.validation ?? null,
      patches,
    });
  }

  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  return entries;
}

async function loadExisting() {
  if (!(await exists(MANIFEST))) return null;
  try {
    return await readJson(MANIFEST);
  } catch {
    return null;
  }
}

async function loadAssetNames() {
  const f = opt("--assets-file");
  if (!f) return null;
  if (!(await exists(f))) return new Set();
  const raw = await fs.readFile(f, "utf8");
  return new Set(raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
}

async function cmdCheck(entries, existing) {
  if (!existing) die("no patch_index.json to check");
  const byId = new Map(entries.map((e) => [e.slug, e]));
  const listed = existing.entries ?? [];
  let bad = 0;

  for (const want of listed) {
    const got = byId.get(want.slug);
    if (!got) {
      console.error(`MISSING  ${want.slug} - in manifest but no folder`);
      bad++;
      continue;
    }
    for (const v of VARIANTS) {
      const a = want.patches?.[v];
      const b = got.patches?.[v];
      if (!a || !b) {
        console.error(`MISSING  ${want.slug}/${v}`);
        bad++;
      } else if (a.sha256 !== b.sha256) {
        console.error(`SHA      ${want.slug}/${v}\n  manifest ${a.sha256}\n  file     ${b.sha256}`);
        bad++;
      } else if (a.size !== b.size) {
        console.error(`SIZE     ${want.slug}/${v} manifest ${a.size} file ${b.size}`);
        bad++;
      } else {
        console.log(`ok       ${want.slug}/${v}  ${b.sha256.slice(0, 12)}...  ${b.size}`);
      }
    }
  }

  for (const e of entries) {
    if (!listed.some((x) => x.slug === e.slug)) {
      console.error(`UNLISTED ${e.slug} - folder present but not in manifest`);
      bad++;
    }
  }

  if (bad) die(`${bad} problem(s) found`);
  console.log(`\nAll ${entries.length} entries verified against their folders.`);
}

async function cmdListOrphans(entries) {
  const assets = await loadAssetNames();
  if (assets === null) die("--list-orphans requires --assets-file");
  const wanted = new Set(entries.flatMap((e) => VARIANTS.map((v) => `${e.slug}-${v}.vcdiff`)));
  for (const name of assets) {
    if (name.endsWith(".vcdiff") && !wanted.has(name)) console.log(name);
  }
}

async function cmdGenerate(entries, existing) {
  const assets = await loadAssetNames();
  const prev = new Map((existing?.entries ?? []).map((e) => [e.slug, e]));

  // Stage only what is new or changed: a normal push uploads two files, not 254 MB.
  await fs.rm(STAGING, { recursive: true, force: true });
  await fs.mkdir(STAGING, { recursive: true });

  let staged = 0;
  for (const e of entries) {
    for (const v of VARIANTS) {
      const assetName = `${e.slug}-${v}.vcdiff`;
      const unchanged = prev.get(e.slug)?.patches?.[v]?.sha256 === e.patches[v].sha256;
      const uploaded = assets === null ? unchanged : assets.has(assetName);
      if (unchanged && uploaded) continue;
      await fs.copyFile(
        path.join(PATCHES_DIR, e.folder_name, `${v}.vcdiff`),
        path.join(STAGING, assetName),
      );
      staged++;
      console.log(`staged   ${assetName}  (${e.patches[v].size} bytes)`);
    }
  }

  // Keep `updated` stable when nothing changed, so CI does not make empty commits.
  const body = { schemaVersion: SCHEMA_VERSION, entries };
  const same =
    existing &&
    JSON.stringify({ schemaVersion: existing.schemaVersion, entries: existing.entries }) ===
      JSON.stringify(body);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    updated: same ? existing.updated : new Date().toISOString(),
    entries,
  };

  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\n${entries.length} entries, ${staged} asset(s) staged, manifest ${same ? "unchanged" : "updated"}.`);
}

const entries = await buildEntries();
const existing = await loadExisting();
if (has("--check")) await cmdCheck(entries, existing);
else if (has("--list-orphans")) await cmdListOrphans(entries);
else await cmdGenerate(entries, existing);
