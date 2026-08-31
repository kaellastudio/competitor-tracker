#!/usr/bin/env node
// Competitor tracker. Reads a watchlist, fetches each public page, and reports
// what changed since the last run.
//
//   node src/track.mjs --config sample-data/watchlist.json
//
// Public pages only. Nothing here logs in, and nothing here pretends to be a
// browser it is not. See README for why that line matters.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UA = 'kaellastudio-competitor-tracker/1.0 (+https://kaellastudio.com; contact hello@kaellastudio.com)';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

// ---- politeness ----------------------------------------------------------
// One request at a time with a gap between them. A tracker that hammers a
// small shop's server is a tracker that gets the IP blocked, and rightly so.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// robots.txt is checked per host and cached for the run. Honouring it is not
// optional just because the page is technically reachable.
const robotsCache = new Map();
async function allowedByRobots(url) {
  const { origin, pathname } = new URL(url);
  if (!robotsCache.has(origin)) {
    let rules = [];
    try {
      const res = await fetch(new URL('/robots.txt', origin), { headers: { 'user-agent': UA } });
      if (res.ok) {
        let appliesToUs = false;
        for (const raw of (await res.text()).split('\n')) {
          const line = raw.split('#')[0].trim();
          const [kRaw, ...rest] = line.split(':');
          const k = (kRaw || '').trim().toLowerCase();
          const v = rest.join(':').trim();
          if (k === 'user-agent') appliesToUs = v === '*';
          else if (k === 'disallow' && appliesToUs && v) rules.push(v);
        }
      }
    } catch { /* unreachable robots.txt is not consent, but it is not a ban either */ }
    robotsCache.set(origin, rules);
  }
  return !robotsCache.get(origin).some((p) => pathname.startsWith(p));
}

// ---- extraction ----------------------------------------------------------
// Deliberately crude. Regex over HTML is wrong for parsing a document, and
// right for "did the headline change", which is all this needs to answer.
const strip = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const pick = (html, re) => (html.match(re)?.[1] ?? '').trim() || null;

function extract(html) {
  return {
    title: pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: pick(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i),
    h1: strip(pick(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? '') || null,
    // Prices move constantly and are the single most useful signal here.
    prices: [...new Set((strip(html).match(/[£$€]\s?\d[\d,]*(?:\.\d{2})?/g) ?? []))].slice(0, 25),
    textHash: createHash('sha256').update(strip(html)).digest('hex').slice(0, 16)
  };
}

// ---- diffing -------------------------------------------------------------
function diff(before, after) {
  if (!before) return [{ field: 'page', kind: 'first seen', from: null, to: after.title }];
  const changes = [];
  for (const f of ['title', 'description', 'h1']) {
    if (before[f] !== after[f]) changes.push({ field: f, kind: 'changed', from: before[f], to: after[f] });
  }
  const gone = (before.prices ?? []).filter((p) => !(after.prices ?? []).includes(p));
  const added = (after.prices ?? []).filter((p) => !(before.prices ?? []).includes(p));
  if (added.length) changes.push({ field: 'prices', kind: 'added', from: null, to: added.join(', ') });
  if (gone.length) changes.push({ field: 'prices', kind: 'removed', from: gone.join(', '), to: null });
  // Only report a body change when nothing more specific fired. Otherwise every
  // run reports "the text changed" for a rotating testimonial and the signal
  // drowns in noise.
  if (!changes.length && before.textHash !== after.textHash) {
    changes.push({ field: 'body', kind: 'changed', from: before.textHash, to: after.textHash });
  }
  return changes;
}

// ---- main ----------------------------------------------------------------
const configPath = arg('--config', join(ROOT, 'sample-data/watchlist.json'));
const statePath = arg('--state', join(ROOT, '.state/snapshots.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};

const report = [];
for (const target of config.targets) {
  const { name, url } = target;
  try {
    if (!await allowedByRobots(url)) {
      report.push({ name, url, status: 'skipped', note: 'disallowed by robots.txt' });
      continue;
    }
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!res.ok) {
      // A 404 on a product page is itself news: the line may be discontinued.
      report.push({ name, url, status: 'error', note: `HTTP ${res.status}` });
      continue;
    }
    const after = extract(await res.text());
    const changes = diff(state[url], after);
    state[url] = { ...after, checkedAt: new Date().toISOString() };
    report.push({ name, url, status: changes.length ? 'changed' : 'no change', changes });
  } catch (err) {
    // One unreachable site must not abort the run. Report and carry on.
    report.push({ name, url, status: 'error', note: err.message });
  }
  await sleep(config.delayMs ?? 2000);
}

mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify(state, null, 2));

// ---- output --------------------------------------------------------------
const changed = report.filter((r) => r.status === 'changed');
console.log(`\nChecked ${report.length} pages, ${changed.length} changed\n`);
for (const r of report) {
  if (r.status === 'no change') continue;
  console.log(`${r.name}  (${r.status})`);
  console.log(`  ${r.url}`);
  if (r.note) console.log(`  ${r.note}`);
  for (const c of r.changes ?? []) {
    console.log(`  ${c.field} ${c.kind}`);
    if (c.from) console.log(`    was: ${String(c.from).slice(0, 120)}`);
    if (c.to)   console.log(`    now: ${String(c.to).slice(0, 120)}`);
  }
  console.log();
}
if (!changed.length) console.log('Nothing moved since the last run.\n');
