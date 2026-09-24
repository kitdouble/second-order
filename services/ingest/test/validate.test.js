import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBatch, validateStart } from "../src/validate.js";

const good = {
  session_id: "s_001",
  trials: [{ step: "main", trial_index: 0, data: { rt: 512, correct: true } }],
};

test("accepts a well-formed batch", () => {
  assert.equal(validateBatch(good).ok, true);
});

test("rejects bad ids and steps", () => {
  assert.equal(validateBatch({ ...good, session_id: "has space" }).ok, false);
  assert.equal(validateBatch({ ...good, trials: [{ step: "Main!", trial_index: 0, data: {} }] }).ok, false);
});

test("rejects empty or malformed trials", () => {
  assert.equal(validateBatch({ ...good, trials: [] }).ok, false);
  assert.equal(validateBatch({ ...good, trials: [{ step: "main", trial_index: -1, data: {} }] }).ok, false);
  assert.equal(validateBatch({ ...good, trials: [{ step: "main", trial_index: 1.5, data: {} }] }).ok, false);
  assert.equal(validateBatch({ ...good, trials: [{ step: "main", trial_index: 0, data: [] }] }).ok, false);
});

test("rejects a repeated step and index within a batch", () => {
  const trials = [
    { step: "main", trial_index: 3, data: {} },
    { step: "main", trial_index: 3, data: {} },
  ];
  assert.equal(validateBatch({ ...good, trials }).ok, false);
});

test("start requires a plausible hash", () => {
  assert.equal(validateStart({ hash: "abc" }).ok, false);
  assert.equal(validateStart({ hash: "0123456789abcdef", pid: "5f1a" }).ok, true);
  assert.equal(validateStart({ hash: "0123456789abcdef", pid: "bad pid" }).ok, false);
});
