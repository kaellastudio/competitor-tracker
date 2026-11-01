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
// A server that accepts the connection and then never answers would otherwise
// hang the whole run. One slow site must not stop the other pages being checked.
const TIMEOUT_MS = Number(process.env.TRACKER_TIMEOUT_MS) || 20_000;

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
//
// Parsed per RFC 9309: consecutive User-agent lines share one group, a group
// naming this tracker beats the * group, and the longest matching rule wins,
// with Allow beating Disallow on a tie.
const BOT_TOKEN = 'kaellastudio-competitor-tracker';
const robotsCache = new Map();

function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (k === 'user-agent') {
      if (!lastWasAgent) groups.push(current = { agents: [], rules: [] });
      current.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (k === 'allow' || k === 'disallow') && v) current.rules.push({ allow: k === 'allow', path: v });
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== '*' && BOT_TOKEN.startsWith(a)));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

// Supports the two wildcards robots.txt defines: * for any run of characters,
// and a trailing $ to anchor the end of the path.
const ruleMatches = (rule, path) => {
  const anchored = rule.endsWith('$');
  const body = (anchored ? rule.slice(0, -1) : rule)
    .split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
};

async function allowedByRobots(url) {
  const { origin, pathname, search } = new URL(url);
  if (!robotsCache.has(origin)) {
    let rules = [];
    try {
      const res = await fetch(new URL('/robots.txt', origin), {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) rules = parseRobots(await res.text());
      // A 5xx means the site could not say. RFC 9309 treats that as "stay out".
      else if (res.status >= 500) rules = [{ allow: false, path: '/' }];
    } catch { /* unreachable robots.txt is not consent, but it is not a ban either */ }
    robotsCache.set(origin, rules);
  }
  const path = pathname + search;
  let best = null;
  for (const r of robotsCache.get(origin)) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// ---- extraction ----------------------------------------------------------
// Deliberately crude. Regex over HTML is wrong for parsing a document, and
// right for "did the headline change", which is all this needs to answer.
const strip = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&pound;/g, '£').replace(/&euro;/g, '€')
  .replace(/&amp;/g, '&');

const pick = (html, re) => {
  const m = html.match(re);
  const v = m ? decode(m[m.length - 1]).replace(/\s+/g, ' ').trim() : '';
  return v || null;
};

// The meta tag can list its attributes in either order, and the content can
// contain the other kind of quote ("It's new"), so match the opening quote.
const metaDescription = (html) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*(["'])description\1/i.test(tag)) continue;
    return pick(tag, /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
  }
  return null;
};

function extract(html) {
  const text = decode(strip(html));
  return {
    title: pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: metaDescription(html),
    h1: decode(strip(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '')) || null,
    // Prices move constantly and are the single most useful signal here.
    // Thousands separators only in groups of three, so "£12, £15" reads as
    // two prices rather than "£12,".
    prices: [...new Set(text.match(/[£$€]\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?/g) ?? [])]
      .map((p) => p.replace(/\s/g, '')).slice(0, 25),
    textHash: createHash('sha256').update(text).digest('hex').slice(0, 16)
  };
}

// ---- diffing -------------------------------------------------------------
function diff(before, after) {
  if (!before) return [{ field: 'page', kind: 'first seen', from: null, to: after.title }];
  if (before.gone) return [{ field: 'page', kind: 'back', from: `HTTP ${before.httpStatus}`, to: after.title }];
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
for (const [i, target] of config.targets.entries()) {
  const { name, url } = target;
  try {
    if (!await allowedByRobots(url)) {
      report.push({ name, url, status: 'skipped', note: 'disallowed by robots.txt' });
      continue;
    }
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 404 || res.status === 410) {
      // A product page that stopped resolving is news: the line may be
      // discontinued. Report it once, when it happens, not on every run after.
      const before = state[url];
      const changes = before?.gone ? [] : [{
        field: 'page', kind: before ? 'gone' : 'not found on first check',
        from: before?.title ?? null, to: `HTTP ${res.status}`
      }];
      state[url] = { gone: true, httpStatus: res.status, checkedAt: new Date().toISOString() };
      report.push({ name, url, status: changes.length ? 'changed' : 'no change', changes });
      continue;
    }
    if (!res.ok) {
      // Anything else (403, 500, 503) is usually temporary. Report it, and keep
      // the last good snapshot so the next run diffs against real content.
      report.push({ name, url, status: 'error', note: `HTTP ${res.status}` });
      continue;
    }
    const after = extract(await res.text());
    const changes = diff(state[url], after);
    state[url] = { ...after, checkedAt: new Date().toISOString() };
    report.push({ name, url, status: changes.length ? 'changed' : 'no change', changes });
  } catch (err) {
    // One unreachable site must not abort the run. Report and carry on.
    const note = err.name === 'TimeoutError' ? `no response within ${TIMEOUT_MS / 1000}s` : (err.cause?.code ?? err.message);
    report.push({ name, url, status: 'error', note });
  } finally {
    if (i < config.targets.length - 1) await sleep(config.delayMs ?? 2000);
  }
}

mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify(state, null, 2));

// ---- output --------------------------------------------------------------
const changed = report.filter((r) => r.status === 'changed');
const failed = report.filter((r) => r.status === 'error' || r.status === 'skipped');
console.log(`\nChecked ${report.length} pages, ${changed.length} changed${failed.length ? `, ${failed.length} not checked` : ''}\n`);
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
if (!changed.length && !failed.length) console.log('Nothing moved since the last run.\n');
else if (!changed.length) console.log('Nothing moved on the pages that could be checked.\n');
if (failed.some((r) => r.status === 'error')) process.exitCode = 1;
