// Block registry. Specs pin versions ("dots-2afc-confidence@1"); a changed
// block gets a new version so studies that already ran never change.
import { z } from "zod";
import dots from "./dots.js";
import choice from "./choice.js";
import custom from "./custom.js";
import { consent, instructions, attention, likert, debrief } from "./simple.js";

const ALL = [consent, instructions, dots, choice, attention, likert, debrief, custom];

export const BLOCKS = Object.fromEntries(ALL.map((b) => [b.ref, b]));

export function getBlock(ref) {
  return BLOCKS[ref] ?? null;
}

/** A step's output columns (custom blocks declare theirs in params). */
export function blockColumns(block, params) {
  return block?.columnsFor && params ? block.columnsFor(params) : block?.columns ?? {};
}

/** Catalog for agents and the UI: what exists, its parameters and outputs. */
export function blockCatalog() {
  return ALL.map((b) => ({
    ref: b.ref,
    title: b.title,
    description: b.description,
    columns: b.custom ? "declared in params.columns" : b.columns,
    unverified: Boolean(b.custom),
    summary_values: b.summaryKeys ?? [],
    supports_sdt_measures: Boolean(b.sdt),
    reviewer_notes: b.reviewerNotes,
    params_schema: safeJsonSchema(b.params),
  }));
}

function safeJsonSchema(schema) {
  try {
    // zod v4 ships JSON Schema export; "input" shows defaults as optional.
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return null;
  }
}
