// Snapshot test for the urgent-care and pain text, and docs/safety.md quoting it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAIN_TEXT, URGENT_CARE_TEXT } from "../engine/safety-text.ts";

const URGENT_SNAPSHOT = `Stop exercising now.
If you have chest pain or pressure, fainting, severe shortness of breath, or signs of a stroke (face drooping, arm or leg weakness or numbness, slurred speech, sudden severe headache), call your local emergency number now.
Do not drive yourself. If you are alone, tell someone near you.
This coach cannot assess symptoms. Training stays on hold until you tell me it is safe to continue.`;

const PAIN_SNAPSHOT = `Stop the exercise that causes the pain.
Contact a clinician for new pain, pain that gets worse, or pain that does not settle.
This coach cannot assess pain. It can only make training easier or pause it.`;

test("urgent-care text matches the snapshot", () => {
  assert.equal(URGENT_CARE_TEXT, URGENT_SNAPSHOT);
});

test("pain text matches the snapshot", () => {
  assert.equal(PAIN_TEXT, PAIN_SNAPSHOT);
});

test("the text says the required things plainly", () => {
  assert.match(URGENT_CARE_TEXT, /^Stop exercising now\./);
  for (const s of ["chest pain", "fainting", "stroke", "emergency number"]) assert.ok(URGENT_CARE_TEXT.includes(s), s);
  assert.match(PAIN_TEXT, /Contact a clinician for new pain, pain that gets worse/);
});

test("the text names no diagnosis and gives no medication advice", () => {
  const all = `${URGENT_CARE_TEXT}\n${PAIN_TEXT}`.toLowerCase();
  for (const w of ["heart attack", "cardiac", "angina", "arrhythmia", "tendinitis", "tendonitis", "sprain", "strain", "fracture", "hernia", "sciatica", "concussion", "aneurysm", "you have a", "ibuprofen", "aspirin", "painkiller", "supplement"]) {
    assert.ok(!all.includes(w), `must not say ${w}`);
  }
});

test("docs/safety.md quotes both texts verbatim", () => {
  const doc = readFileSync(new URL("../docs/safety.md", import.meta.url), "utf8");
  assert.ok(doc.includes("```text\n" + URGENT_CARE_TEXT + "\n```"));
  assert.ok(doc.includes("```text\n" + PAIN_TEXT + "\n```"));
});
