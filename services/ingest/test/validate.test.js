import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBatch } from "../src/validate.js";

const good = {
  study_hash: "abc123",
  session_id: "s_001",
  trials: [{ trial_index: 0, data: { rt: 512, correct: true } }],
};

test("accepts a well-formed batch", () => {
  assert.equal(validateBatch(good).ok, true);
});

test("rejects bad ids", () => {
  assert.equal(validateBatch({ ...good, session_id: "has space" }).ok, false);
  assert.equal(validateBatch({ ...good, study_hash: "" }).ok, false);
});

test("rejects empty or malformed trials", () => {
  assert.equal(validateBatch({ ...good, trials: [] }).ok, false);
  assert.equal(validateBatch({ ...good, trials: [{ trial_index: -1, data: {} }] }).ok, false);
  assert.equal(validateBatch({ ...good, trials: [{ trial_index: 1.5, data: {} }] }).ok, false);
  assert.equal(validateBatch({ ...good, trials: [{ trial_index: 0, data: [] }] }).ok, false);
});

test("rejects repeated trial_index within a batch", () => {
  const trials = [
    { trial_index: 3, data: {} },
    { trial_index: 3, data: {} },
  ];
  assert.equal(validateBatch({ ...good, trials }).ok, false);
});
