// From the Meta Lab jsPsych kit (src/preview/timeline.js), unchanged.
// Pure helpers for reading and slicing a jsPsych timeline in preview mode.
// A path is a list of indices, e.g. [1, 0] is the first child of the
// second top-level node.

const isBlock = (node) => Array.isArray(node?.timeline);

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(text, max = 48) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fallbackLabel(node, index) {
  if (isBlock(node)) return `Block ${index + 1}`;
  if (typeof node.stimulus === "string" && stripHtml(node.stimulus)) {
    return truncate(stripHtml(node.stimulus));
  }
  return `Trial ${index + 1}`;
}

function blockDetails(node) {
  const details = [];
  const vars = node.timeline_variables;
  if (Array.isArray(vars)) details.push(`${vars.length} timeline variable rows`);
  if (node.repetitions > 1) details.push(`× ${node.repetitions} repetitions`);
  if (node.randomize_order) details.push("randomised");
  if (node.sample) details.push(`sample: ${node.sample.type}`);
  if (node.conditional_function) details.push("conditional");
  if (node.loop_function) details.push("loops");
  return details;
}

/** Describe a timeline as a tree of { path, label, kind, details, children }. */
export function describeTimeline(nodes, parentPath = []) {
  return nodes.map((node, index) => {
    const path = [...parentPath, index];
    if (isBlock(node)) {
      return {
        path,
        kind: "block",
        label: node.name ?? fallbackLabel(node, index),
        details: blockDetails(node),
        children: describeTimeline(node.timeline, path),
      };
    }
    const plugin = node.type?.info?.name ?? "unknown plugin";
    return {
      path,
      kind: "trial",
      label: node.name ?? fallbackLabel(node, index),
      details: [plugin],
      children: [],
    };
  });
}

/** The timeline from `path` to the end of the experiment. */
export function sliceFrom(nodes, [index, ...rest]) {
  if (rest.length === 0) return nodes.slice(index);
  const node = nodes[index];
  return [{ ...node, timeline: sliceFrom(node.timeline, rest) }, ...nodes.slice(index + 1)];
}

/** Only the node at `path`, kept inside its parent blocks so timeline
 *  variables and other block settings still apply. */
export function sliceOnly(nodes, [index, ...rest]) {
  const node = nodes[index];
  if (rest.length === 0) return [node];
  return [{ ...node, timeline: sliceOnly(node.timeline, rest) }];
}

/** Find the described item at `path`, or undefined if the path is invalid. */
export function findItem(items, [index, ...rest]) {
  const item = items[index];
  if (!item || rest.length === 0) return item;
  return findItem(item.children, rest);
}

/** Labels of every item along `path`, e.g. ["Practice", "Colour trial"]. */
export function labelsAlong(items, path) {
  const labels = [];
  let level = items;
  for (const index of path) {
    const item = level?.[index];
    if (!item) break;
    labels.push(item.label);
    level = item.children;
  }
  return labels;
}

/** Paths are shown 1-based ("2.1") to match the numbers in the timeline view. */
export const formatPath = (path) => path.map((index) => index + 1).join(".");

export function parsePath(text) {
  if (!/^[1-9]\d*(\.[1-9]\d*)*$/.test(text)) return null;
  return text.split(".").map((part) => Number(part) - 1);
}
