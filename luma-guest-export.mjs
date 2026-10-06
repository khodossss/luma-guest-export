#!/usr/bin/env node
// Export guest lists of every event in every Luma calendar you manage to CSV.
//
// Calls Luma's internal API (the one the dashboard itself uses) with a live browser session:
// a person signs in and confirms access (sudo) in the opened window. Each file is Luma's own CSV,
// byte for byte, under the name Luma suggests (characters invalid on Windows replaced with "_",
// as the browser does). See README.md for details.

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const API = 'https://api.luma.com';
const SITE = 'https://luma.com';
const MANIFEST = '.luma-export.json';
const HUMAN_TIMEOUT = 15 * 60_000;

const { values: opts } = parseArgs({
  options: {
    out: { type: 'string' },
    session: { type: 'string', default: path.join(os.homedir(), '.luma-guest-export', 'session.json') },
    force: { type: 'boolean', default: false },
    delay: { type: 'string', default: '1500' },
    browser: { type: 'string', default: 'chrome' },
    calendar: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (opts.help || !opts.out) {
  console.log(`Usage: node luma-guest-export.mjs --out <dir> [--session <file>] [--force] [--delay <ms>] [--calendar <name|cal-id>]... [--browser chrome|msedge|chromium]

  --out       where to save the CSVs (keep outside git: they contain guest personal data)
  --session   Luma session file (default ${path.join(os.homedir(), '.luma-guest-export', 'session.json')})
  --force     re-download everything, ignoring previous downloads
  --delay     pause between events, ms (default 1500)
  --calendar  only these calendars (name or cal-id); repeatable
  --browser   chrome | msedge | chromium (default chrome, the installed Google Chrome)`);
  process.exit(opts.help ? 0 : 2);
}

const outDir = path.resolve(opts.out);
const delay = Number(opts.delay);
if (!Number.isFinite(delay) || delay < 0) {
  console.error(`--delay: expected a number of milliseconds, got "${opts.delay}"`);
  process.exit(2);
}

class Stop extends Error {}

/** Sanitize a download name the way the browser does on Windows: invalid characters -> "_". */
function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || '_';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, MANIFEST), 'utf8'));
  } catch {
    return { events: {} };
  }
}

function saveManifest(m) {
  const p = path.join(outDir, MANIFEST);
  fs.writeFileSync(p + '.tmp', JSON.stringify(m, null, 2));
  fs.renameSync(p + '.tmp', p);
}

/** Downloaded after the event ended: the guest list won't change, so no need to re-download. */
function isFresh(rec, event) {
  if (!rec || !fs.existsSync(path.join(outDir, rec.file))) return false;
  const end = event.end_at || event.start_at;
  return end && new Date(rec.downloaded_at) > new Date(end);
}

async function apiGet(ctx, url) {
  const r = await ctx.request.get(url);
  if (r.status() === 429) throw new Stop(`Luma returned 429 (too many requests) for ${url}. Wait and run again.`);
  let body;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status(), body };
}

async function ensureLogin(ctx, page) {
  await page.goto(`${SITE}/home/calendars`);
  if (!page.url().includes('/signin')) return;
  console.log('\n>>> Sign in to Luma in the browser window. Waiting up to 15 minutes…');
  await page.waitForURL(u => !u.toString().includes('/signin'), { timeout: HUMAN_TIMEOUT });
  await saveSession(ctx);
  console.log('Signed in, session saved.');
}

async function saveSession(ctx) {
  fs.mkdirSync(path.dirname(opts.session), { recursive: true });
  await ctx.storageState({ path: opts.session });
}

/** Luma requires access confirmation (email code) before exporting; a person does this. */
async function confirmSudo(page, eventId) {
  console.log('\n>>> Luma asks to confirm access: in the browser window click "Send Email Code" and enter the code from your email. Waiting up to 15 minutes…');
  await page.goto(`${SITE}/event/manage/${eventId}/guests`);
  const ok = page.waitForResponse(
    r => r.url().includes('/event/admin/download-guests-csv') && r.status() === 200,
    { timeout: HUMAN_TIMEOUT },
  );
  await page.getByRole('button', { name: 'Download as CSV' }).click();
  await ok;
  console.log('Access confirmed.');
}

async function listEvents(ctx, calId) {
  const events = new Map();
  for (const period of ['future', 'past']) {
    let cursor = null;
    do {
      const url = `${API}/calendar/admin/get-events?calendar_api_id=${calId}&pagination_limit=50&period=${period}`
        + (cursor ? `&pagination_cursor=${encodeURIComponent(cursor)}` : '');
      const { status, body } = await apiGet(ctx, url);
      if (status !== 200) throw new Error(`get-events ${calId} ${period}: HTTP ${status} ${JSON.stringify(body)}`);
      for (const e of body.entries) events.set(e.event.api_id, { ...e.event, is_manager: e.is_manager });
      cursor = body.has_more ? body.next_cursor : null;
    } while (cursor);
  }
  return [...events.values()];
}

/** Luma's own CSV: the API returns an S3 link, and the file may not be there right away. */
async function fetchCsv(ctx, page, eventId) {
  const url = `${API}/event/admin/download-guests-csv?event_api_id=${eventId}&sort_column=registered_or_created_at&sort_direction=desc`;
  let { status, body } = await apiGet(ctx, url);
  if (status === 403 && body?.code === 'auth/sudo-mode-required') {
    await confirmSudo(page, eventId);
    ({ status, body } = await apiGet(ctx, url));
  }
  if (status !== 200 || !body?.download_url) throw new Error(`HTTP ${status} ${JSON.stringify(body)}`);

  for (let i = 0; i < 60; i++) {
    const r = await ctx.request.get(body.download_url);
    if (r.status() === 200) return { filename: body.filename, data: await r.body() };
    if (r.status() !== 403 && r.status() !== 404) throw new Error(`S3: HTTP ${r.status()}`);
    await sleep(1000);
  }
  throw new Error('file did not appear on S3 within 60 s');
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = loadManifest();
  const seen = new Set(); // an event can appear in several calendars; export it once
  const stats = { calendars: 0, events: 0, downloaded: 0, skipped: 0, foreign: 0, errors: [] };

  const browser = await chromium.launch({
    headless: false,
    channel: opts.browser === 'chromium' ? undefined : opts.browser,
  });
  const ctx = await browser.newContext({
    storageState: fs.existsSync(opts.session) ? opts.session : undefined,
    acceptDownloads: false,
  });
  const page = await ctx.newPage();

  try {
    await ensureLogin(ctx, page);

    const { status, body } = await apiGet(ctx, `${API}/calendar/admin/list`);
    if (status !== 200) throw new Stop(`calendar/admin/list: HTTP ${status} ${JSON.stringify(body)}`);
    let calendars = body.infos.map(i => i.calendar);
    if (opts.calendar?.length) {
      calendars = calendars.filter(c => opts.calendar.includes(c.name) || opts.calendar.includes(c.api_id));
      const known = new Set(calendars.flatMap(c => [c.name, c.api_id]));
      const missing = opts.calendar.filter(c => !known.has(c));
      if (missing.length) throw new Stop(`No such calendars: ${missing.join(', ')}. Available: ${body.infos.map(i => i.calendar.name).join(', ')}`);
    }
    stats.calendars = calendars.length;

    for (const cal of calendars) {
      const events = await listEvents(ctx, cal.api_id);
      const foreign = events.filter(e => !e.is_manager).length;
      console.log(`\n${cal.name}: ${events.length} events` + (foreign ? `, ${foreign} by other organizers` : ''));
      const calDir = safeName(cal.name);
      fs.mkdirSync(path.join(outDir, calDir), { recursive: true });

      for (const ev of events) {
        if (seen.has(ev.api_id)) continue;
        seen.add(ev.api_id);
        stats.events++;
        // Another organizer's event shown in the calendar: Luma refuses its guest list (403).
        if (!ev.is_manager) { stats.foreign++; continue; }
        const rec = manifest.events[ev.api_id];
        if (!opts.force && isFresh(rec, ev)) { stats.skipped++; continue; }
        try {
          const { filename, data } = await fetchCsv(ctx, page, ev.api_id);
          if (!data.subarray(0, 64).toString('utf8').replace(/^﻿/, '').startsWith('guest_id,')) {
            throw new Error('response does not look like a Luma guest CSV');
          }
          const file = `${calDir}/${safeName(filename)}`;
          fs.writeFileSync(path.join(outDir, file) + '.part', data);
          fs.renameSync(path.join(outDir, file) + '.part', path.join(outDir, file));
          if (rec && rec.file !== file) fs.rmSync(path.join(outDir, rec.file), { force: true });
          manifest.events[ev.api_id] = { file, calendar: cal.name, name: ev.name, start_at: ev.start_at, end_at: ev.end_at, downloaded_at: new Date().toISOString() };
          saveManifest(manifest);
          stats.downloaded++;
          console.log(`  ✓ ${file}`);
        } catch (e) {
          if (e instanceof Stop) throw e;
          stats.errors.push({ name: ev.name, url: `${SITE}/event/manage/${ev.api_id}/guests`, error: e.message });
          console.log(`  ✗ ${ev.name}: ${e.message}`);
        }
        await sleep(delay);
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    stats.stopped = e.message;
  } finally {
    await saveSession(ctx).catch(() => {});
    await browser.close();
  }

  console.log(`\nCalendars: ${stats.calendars}, events: ${stats.events}, downloaded: ${stats.downloaded}, skipped (up to date): ${stats.skipped}, other organizers (no access): ${stats.foreign}, errors: ${stats.errors.length}`);
  for (const e of stats.errors) console.log(`  ✗ ${e.name} — ${e.url}\n    ${e.error}`);
  if (stats.stopped) console.log(`\nSTOPPED: ${stats.stopped}`);
  console.log(`Files: ${outDir}`);
  process.exitCode = stats.stopped || stats.errors.length ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
