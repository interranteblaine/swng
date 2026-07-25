#!/usr/bin/env node
// Seed a golf course into swng (create a new course, or add tees to an existing one)
// through the public HTTP API — the SAME wire the web app uses. Node 20+ (global fetch),
// zero dependencies.
//
// USAGE
//   node seed-course.mjs <spec.json>            # DRY RUN: validate + print body + checksums, sends nothing
//   SWNG_TOKEN=<id-token> node seed-course.mjs <spec.json> --send   # actually create/supersede
//
// The spec (JSON):
//   {
//     "stage": "prod",                 // "prod" | "beta"  (or pass --stage)
//     "courseId": "…",                 // OPTIONAL. Absent => CREATE a new course.
//                                       //           Present => SUPERSEDE: keep every existing tee
//                                       //           verbatim (by teeId) and APPEND the tees below.
//     "name": "Rolling Oaks, Rocky Point, NY",
//     "teeSets": [
//       { "name": "White", "rating": 60.6, "slope": 107,   // omit rating+slope together for an unrated tee
//         "holes": [[1,4,266,7],[2,3,145,11], /* … */ [18,5,440,4]] }  // [number, par, yardage, strokeIndex]
//     ]
//   }
//
// AUTH: writes are golfer-authed. Get YOUR id token from the signed-in app so the course is
// attributed to you (never a throwaway account): devtools console →
//   JSON.parse(localStorage.getItem('swng:auth')).idToken
// then `export SWNG_TOKEN=<that>`. Tokens last ~1h; grab it fresh right before --send.

import { readFileSync } from "node:fs";

const API = { prod: "https://jmdpm562u0.execute-api.us-east-1.amazonaws.com", beta: "https://jvj2x2492l.execute-api.us-east-1.amazonaws.com" };

const args = process.argv.slice(2);
const send = args.includes("--send");
const specPath = args.find((a) => !a.startsWith("--"));
const stageFlag = args.includes("--stage") ? args[args.indexOf("--stage") + 1] : undefined;
if (!specPath) { console.error("usage: node seed-course.mjs <spec.json> [--send] [--stage prod|beta]"); process.exit(2); }

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const stage = stageFlag ?? spec.stage;
if (stage !== "prod" && stage !== "beta") { console.error(`stage must be "prod" or "beta" (got ${stage})`); process.exit(2); }
const base = API[stage];

// ——— turn the [n,par,yds,si] shorthand into the wire hole shape ———
const toHoles = (rows) => rows.map(([number, par, yardage, strokeIndex]) => ({ number, par, yardage, strokeIndex }));

// ——— local validation: mirror packages/domain/src/course/course.ts so a bad card fails HERE,
// not as an opaque 400 after a live call. Same rules the server enforces. ———
function validateTee(t) {
  const errs = [];
  const holes = t.holes;
  const n = holes.length;
  if (n !== 9 && n !== 18) errs.push(`${t.name}: ${n} holes, must be 9 or 18`);
  const hasR = t.rating !== undefined, hasS = t.slope !== undefined;
  if (hasR !== hasS) errs.push(`${t.name}: rating and slope must be set together, or neither (unrated)`);
  if (hasR && (t.rating < 30 || t.rating > 90)) errs.push(`${t.name}: rating ${t.rating} outside 30..90`);
  if (hasS && (!Number.isInteger(t.slope) || t.slope < 55 || t.slope > 155)) errs.push(`${t.name}: slope ${t.slope} outside 55..155`);
  holes.forEach((h, i) => {
    if (h.number !== i + 1) errs.push(`${t.name}: hole at position ${i + 1} numbered ${h.number} (must be 1..N in order)`);
    if (!Number.isInteger(h.yardage)) errs.push(`${t.name}: hole ${h.number} yardage not an integer`);
  });
  const sis = holes.map((h) => h.strokeIndex).sort((a, b) => a - b);
  if (!sis.every((v, i) => v === i + 1)) errs.push(`${t.name}: strokeIndex not a permutation of 1..${n} (got ${sis.join(",")})`);
  return errs;
}

function checksum(t) {
  const out = t.holes.slice(0, 9).reduce((s, h) => s + h.yardage, 0);
  const inn = t.holes.slice(9).reduce((s, h) => s + h.yardage, 0);
  const par = t.holes.reduce((s, h) => s + h.par, 0);
  const rs = t.rating !== undefined ? `${t.rating}/${t.slope}` : "unrated";
  return `  ${t.name.padEnd(18)} ${rs.padEnd(11)} par ${par}  yds ${out + inn} (out ${out}${t.holes.length === 18 ? ` in ${inn}` : ""})`;
}

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

// ——— build the tees to add from the spec ———
const newTees = spec.teeSets.map((t) => ({ name: t.name, ...(t.rating !== undefined ? { rating: t.rating } : {}), ...(t.slope !== undefined ? { slope: t.slope } : {}), holes: toHoles(t.holes) }));

const localErrors = newTees.flatMap(validateTee);
console.log(`stage=${stage}  base=${base}`);
console.log(spec.courseId ? `MODE: supersede (add tees to course ${spec.courseId})` : "MODE: create new course");
console.log(`course name: ${spec.name}`);
console.log("tees to add:"); newTees.forEach((t) => console.log(checksum(t)));
if (localErrors.length) { console.error("\nLOCAL VALIDATION FAILED:\n - " + localErrors.join("\n - ")); process.exit(1); }
console.log("local validation: OK (mirrors domain validateCard)");

const run = async () => {
  const token = process.env.SWNG_TOKEN;

  if (!spec.courseId) {
    // CREATE
    const body = { name: spec.name, teeSets: newTees };
    if (!send) { console.log("\n--- DRY RUN (POST /courses) — pass --send to create ---"); console.log(JSON.stringify(body, null, 2)); return; }
    if (!token) { console.error("SWNG_TOKEN required for --send"); process.exit(2); }
    const { status, json } = await api("POST", "/courses", body, token);
    if (status !== 201) { console.error("CREATE failed", status, json); process.exit(1); }
    report(json.course);
    console.log(`\nURL: https://${stage === "prod" ? "swng.golf" : "beta.swng.golf"}/courses/${json.course.courseId}`);
    return;
  }

  // SUPERSEDE: fetch current, preserve existing tees by teeId, append new ones
  const cur = await api("GET", `/courses/${spec.courseId}`);
  if (cur.status !== 200) { console.error("GET current card failed", cur.status, cur.json); process.exit(1); }
  const card = cur.json.course.card;
  const existing = card.teeSets;
  console.log(`\ncurrent card ${cur.json.course.cardId}: [${existing.map((t) => t.name).join(", ")}] enteredBy=${cur.json.course.enteredBy}`);
  const existingNames = new Set(existing.map((t) => t.name.toLowerCase()));
  const clash = newTees.find((t) => existingNames.has(t.name.toLowerCase()));
  if (clash) { console.error(`tee "${clash.name}" already exists on this card — this tool APPENDS new tees; editing an existing tee is a different op`); process.exit(1); }
  const preserved = existing.map((t) => ({ name: t.name, holes: t.holes, teeId: t.teeId, ...(t.rating !== undefined ? { rating: t.rating } : {}), ...(t.slope !== undefined ? { slope: t.slope } : {}) }));
  const body = { name: card.courseName, supersedes: cur.json.course.cardId, teeSets: [...preserved, ...newTees] };
  if (!send) { console.log("\n--- DRY RUN (PUT /courses/{id}) — pass --send to supersede ---"); console.log(JSON.stringify(body, null, 2)); return; }
  if (!token) { console.error("SWNG_TOKEN required for --send"); process.exit(2); }
  const { status, json } = await api("PUT", `/courses/${spec.courseId}`, body, token);
  if (status !== 200) { console.error("SUPERSEDE failed", status, json); process.exit(1); }
  report(json.course);
};

function report(course) {
  console.log(`\nOK — cardId ${course.cardId}  enteredBy ${course.enteredBy}`);
  course.card.teeSets.forEach((t) => {
    const sis = t.holes.map((h) => h.strokeIndex).sort((a, b) => a - b);
    const ok = sis.every((v, i) => v === i + 1);
    console.log(checksum(t) + `  SI-perm ${ok ? "ok" : "BAD"}  teeId ${t.teeId}`);
  });
}

run();
