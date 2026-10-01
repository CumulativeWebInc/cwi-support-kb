#!/usr/bin/env node
/**
 * sla-validate.js — SLA compliance-log validator + summary generator.
 * Usage:
 *   node tools/sla-validate.js                      validate sla-compliance.jsonl vs sla-targets.json
 *   node tools/sla-validate.js --self-test           run built-in fixtures (empty log, synthetic tickets, malformed row)
 *   node tools/sla-validate.js --write-summary      validate + write sla-compliance-summary.json
 *
 * Exit 0 = valid. Exit 1 = schema violation. Exit 2 = recomputed within-target flag disagrees with the logged flag.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(path.dirname(path.resolve(__filename)));
const LOG = process.env.SLA_LOG || path.join(ROOT, "sla-compliance.jsonl");
const TARGETS_FILE = process.env.SLA_TARGETS || path.join(ROOT, "sla-targets.json");
const SUMMARY = process.env.SLA_SUMMARY || path.join(ROOT, "sla-compliance-summary.json");
const WINDOW_DAYS = 30;

const REQUIRED = ["ticket_id", "received_utc", "unit", "tier"];
const UNITS = ["care", "guide"];
const TIERS = ["free", "paid", "priority"];
const TIME_FIELDS = ["acknowledged_utc", "responded_utc", "resolved_or_escalated_utc"];
const FLAG_FIELDS = ["ack_within_target", "response_within_target", "resolve_within_target"];

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }

function loadTargets() {
  let t;
  try { t = JSON.parse(fs.readFileSync(TARGETS_FILE, "utf8")); }
  catch (e) { fail("cannot read targets " + TARGETS_FILE + ": " + e.message); }
  return t;
}

function targetSeconds(targets, unit, tier) {
  const u = targets.units[unit];
  if (!u) fail("unknown unit in targets: " + unit);
  const t = u.targets[tier];
  if (!t) fail("unknown tier " + tier + " for unit " + unit);
  if (unit === "guide") {
    return {
      ack: t.acknowledge_seconds,
      response: t.answered_from_verified_docs_seconds,
      resolve: t.answered_from_verified_docs_seconds,
    };
  }
  return {
    ack: t.acknowledge_seconds,
    response: t.substantive_response_seconds,
    resolve: t.resolve_or_escalate_seconds,
  };
}

function parseLog(text) {
  const rows = [];
  const seen = new Set();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let r;
    try { r = JSON.parse(line); }
    catch (e) { fail("line " + (i + 1) + " is not valid JSON: " + e.message); }
    const n = i + 1;
    for (const k of REQUIRED) if (!(k in r)) fail("line " + n + ": missing required field " + k);
    if (typeof r.ticket_id !== "string" || !r.ticket_id) fail("line " + n + ": bad ticket_id");
    if (seen.has(r.ticket_id)) fail("line " + n + ": duplicate ticket_id " + r.ticket_id);
    seen.add(r.ticket_id);
    if (!UNITS.includes(r.unit)) fail("line " + n + ": bad unit " + r.unit);
    if (!TIERS.includes(r.tier)) fail("line " + n + ": bad tier " + r.tier);
    if (r.tier === "priority" && r.unit !== "care") fail("line " + n + ": tier priority is only valid for unit care");
    const received = new Date(r.received_utc);
    if (isNaN(received)) fail("line " + n + ": bad received_utc " + r.received_utc);
    for (const k of TIME_FIELDS) {
      if (r[k] != null && isNaN(new Date(r[k]))) fail("line " + n + ": bad " + k + " = " + r[k]);
    }
    for (const k of FLAG_FIELDS) {
      if (r[k] != null && typeof r[k] !== "boolean") fail("line " + n + ": flag " + k + " must be boolean or null");
    }
    if (r.excluded != null && typeof r.excluded !== "boolean") fail("line " + n + ": excluded must be boolean");
    rows.push(r);
  });
  return rows;
}

// Recompute within-target flags from timestamps. awaiting_user_seconds is excluded time.
function recompute(row, targets) {
  const ts = targetSeconds(targets, row.unit, row.tier);
  const received = new Date(row.received_utc).getTime();
  const excluded_wait = Number(row.awaiting_user_seconds || 0) * 1000;
  const out = {};
  const pairs = [
    ["ack_within_target", "acknowledged_utc", ts.ack],
    ["response_within_target", "responded_utc", ts.response],
    ["resolve_within_target", "resolved_or_escalated_utc", ts.resolve],
  ];
  for (const [flag, timeField, limitSec] of pairs) {
    if (row[timeField] == null) { out[flag] = null; continue; }
    const elapsed = (new Date(row[timeField]).getTime() - received - excluded_wait) / 1000;
    if (elapsed < 0) fail(row.ticket_id + ": " + timeField + " is before received_utc");
    out[flag] = elapsed <= limitSec;
  }
  return out;
}

// A ticket is "due" for a flag once received + target has passed. Misses only count on due tickets.
function computeSummary(rows, targets, nowMs) {
  const windowStart = nowMs - WINDOW_DAYS * 86400000;
  const live = rows.filter(r => !r.excluded && new Date(r.received_utc).getTime() >= windowStart);
  const groups = {};
  for (const r of live) {
    const ts = targetSeconds(targets, r.unit, r.tier);
    const key = r.unit + " x " + r.tier;
    groups[key] = groups[key] || {
      unit: r.unit, tier: r.tier, tickets: 0,
      due_ack: 0, hit_ack: 0, due_response: 0, hit_response: 0, due_resolve: 0, hit_resolve: 0,
    };
    const g = groups[key];
    g.tickets++;
    const received = new Date(r.received_utc).getTime();
    const recomputed = recompute(r, targets);
    const slots = [
      ["due_ack", "hit_ack", "ack_within_target", ts.ack],
      ["due_response", "hit_response", "response_within_target", ts.response],
      ["due_resolve", "hit_resolve", "resolve_within_target", ts.resolve],
    ];
    for (const [dueK, hitK, flagK, limitSec] of slots) {
      if (nowMs >= received + limitSec * 1000) {
        g[dueK]++;
        if (recomputed[flagK] === true) g[hitK]++;
      }
    }
  }
  const compliance = {};
  for (const [k, g] of Object.entries(groups)) {
    compliance[k] = {
      tickets: g.tickets,
      ack_pct: g.due_ack ? +(100 * g.hit_ack / g.due_ack).toFixed(1) : null,
      response_pct: g.due_response ? +(100 * g.hit_response / g.due_response).toFixed(1) : null,
      resolve_pct: g.due_resolve ? +(100 * g.hit_resolve / g.due_resolve).toFixed(1) : null,
      due: { ack: g.due_ack, response: g.due_response, resolve: g.due_resolve },
      hits: { ack: g.hit_ack, response: g.hit_response, resolve: g.hit_resolve },
    };
  }
  return {
    schema_version: "1.0.0",
    generated_utc: new Date(nowMs).toISOString(),
    window_days: WINDOW_DAYS,
    window_start_utc: new Date(windowStart).toISOString(),
    window_end_utc: new Date(nowMs).toISOString(),
    tickets_in_window: live.length,
    targets_version: targets.version,
    compliance,
  };
}

function validate() {
  const targets = loadTargets();
  if (!targets.version) fail("targets file missing version");
  let text = "";
  if (fs.existsSync(LOG)) text = fs.readFileSync(LOG, "utf8");
  const rows = parseLog(text);
  for (const r of rows) {
    if (r.excluded) continue;
    const recomputed = recompute(r, targets);
    for (const k of FLAG_FIELDS) {
      if (r[k] != null && r[k] !== recomputed[k]) {
        console.error("FLAG MISMATCH " + r.ticket_id + " " + k + ": logged=" + r[k] + " recomputed=" + recomputed[k]);
        process.exit(2);
      }
    }
  }
  return { rows, targets };
}

function selfTest() {
  const targets = loadTargets();
  let passed = 0;
  const ok = (name, cond) => { if (!cond) { console.error("SELF-TEST FAIL: " + name); process.exit(1); } passed++; console.log("ok: " + name); };

  // 1. empty log validates
  ok("empty log parses to zero rows", parseLog("").length === 0);

  // 2. synthetic tickets: one hit, one ack-miss, one pending-not-due, one excluded
  const now = Date.parse("2026-10-15T12:00:00Z");
  const T = (id, rec, unit, tier, ack, resp, res, extra) =>
    JSON.stringify(Object.assign({ ticket_id: id, received_utc: rec, unit, tier,
      acknowledged_utc: ack, responded_utc: resp, resolved_or_escalated_utc: res,
      excluded: false }, extra || {}));
  const lines = [
    T("T1", "2026-10-10T12:00:00Z", "care", "free", "2026-10-10T13:00:00Z", "2026-10-11T12:00:00Z", "2026-10-12T12:00:00Z"),       // all hits (1h / 24h / 48h)
    T("T2", "2026-10-10T12:00:00Z", "care", "free", "2026-10-11T14:00:00Z", "2026-10-12T12:00:00Z", null),                          // ack miss (26h > 24h), response hit, resolve pending
    T("T3", "2026-10-15T11:59:00Z", "guide", "free", null, null, null),                                                          // received 1 min ago: nothing due
    T("T4", "2026-10-10T12:00:00Z", "guide", "free", null, null, null, { excluded: true, exclusion_reason: "spam" }),           // excluded: never counted
  ];
  const rows = parseLog(lines.join("\n"));
  ok("four rows parse", rows.length === 4);
  const r1 = recompute(rows[0], targets);
  ok("T1 all within target", r1.ack_within_target === true && r1.response_within_target === true && r1.resolve_within_target === true);
  const r2 = recompute(rows[1], targets);
  ok("T2 ack miss detected, response hit, resolve null", r2.ack_within_target === false && r2.response_within_target === true && r2.resolve_within_target === null);
  const r3 = recompute(rows[2], targets);
  ok("T3 all null (nothing happened yet)", r3.ack_within_target === null && r3.response_within_target === null && r3.resolve_within_target === null);
  const s = computeSummary(rows, targets, now);
  ok("excluded T4 not in window count", s.tickets_in_window === 3);
  const cf = s.compliance["care x free"];
  // T1 resolve finished early (10-12) but its 7-day deadline (10-17) has not passed -> not due yet: honest.
  ok("care x free: 2 tickets, 2 due ack (1/2=50%), 2 due response (2/2=100%), 0 due resolve (null)",
    cf.tickets === 2 && cf.ack_pct === 50 && cf.response_pct === 100 && cf.resolve_pct === null);
  const gf = s.compliance["guide x free"];
  ok("guide x free: 1 ticket, nothing due (all pcts null)", gf.tickets === 1 && gf.ack_pct === null && gf.response_pct === null && gf.resolve_pct === null);

  // 3. awaiting-user time excluded from elapsed
  const r5 = JSON.parse(T("T5", "2026-10-10T12:00:00Z", "care", "free", "2026-10-11T14:00:00Z", null, null,
    { awaiting_user_seconds: 4 * 3600 })); // 26h wall, 4h awaiting user -> 22h effective
  ok("awaiting-user time excluded (26h wall -> 22h effective, within 24h)",
    recompute(r5, targets).ack_within_target === true);

  // 4. malformed rows rejected
  const bad = [
    '{not json}',
    JSON.stringify({ ticket_id: "X", unit: "care", tier: "free" }),                    // missing received_utc
    JSON.stringify({ ticket_id: "X", received_utc: "2026-10-10T12:00:00Z", unit: "care", tier: "platinum" }), // bad tier
    JSON.stringify({ ticket_id: "X", received_utc: "2026-10-10T12:00:00Z", unit: "guide", tier: "priority" }), // priority needs care
    T("DUP", "2026-10-10T12:00:00Z", "care", "free", null, null, null) + "\n" +
      T("DUP", "2026-10-10T12:00:00Z", "care", "free", null, null, null),               // duplicate id
  ];
  for (let i = 0; i < bad.length; i++) {
    try {
      // run parseLog in-process but trap the fail() exit
    } catch (e) { /* unreachable: fail() exits */ }
    const { execFileSync } = require("child_process");
    try {
      execFileSync(process.execPath, [__filename, "--parse-stdin"], { input: bad[i], stdio: ["pipe", "pipe", "pipe"] });
      ok("malformed case " + i + " rejected", false);
    } catch (e) { ok("malformed case " + i + " rejected", e.status === 1); }
  }

  // 5. guide priority targets: 24h ack / 72h answer
  const tg = targetSeconds(targets, "guide", "free");
  ok("guide free targets 86400/259200/259200", tg.ack === 86400 && tg.response === 259200 && tg.resolve === 259200);

  console.log("SELF-TEST " + passed + "/" + passed + " passed");
}

if (process.argv.includes("--parse-stdin")) {
  let data = "";
  process.stdin.on("data", c => data += c);
  process.stdin.on("end", () => { parseLog(data); console.log("parsed ok"); });
} else if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const { rows, targets } = validate();
  const summary = computeSummary(rows, targets, Date.now());
  if (process.argv.includes("--write-summary")) {
    fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2) + "\n");
    console.log("wrote " + SUMMARY);
  }
  console.log("VALID: " + rows.length + " rows, targets v" + targets.version +
    ", tickets in 30-day window: " + summary.tickets_in_window);
}
