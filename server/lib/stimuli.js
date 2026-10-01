// The study's uploaded stimuli, by name. The list is fixed into each version when it is saved, so a
// version keeps the exact files it was saved with even if stimuli are later replaced.
//
//   stimulus: stimulus("cat.png")
//   timeline_variables: stimulusNamesIn("faces").map((face) => ({ face, url: stimulus(face) }))
import files from "second-order:manifest";

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const AUDIO = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;

const names = Object.keys(files).sort();

/** URL of a stimulus by its name, e.g. "cat.png" or "faces/f1.png". */
export function stimulus(name) {
  const url = files[name];
  if (url) return url;
  const lower = name.toLowerCase();
  const close = names.filter((n) => n.toLowerCase() === lower || n.toLowerCase().includes(lower.replace(/\.\w+$/, "")));
  throw new Error(
    `There's no stimulus "${name}" in this version.` + (close.length ? ` Did you mean ${close.map((n) => `"${n}"`).join(" or ")}?` : " Use list_stimuli to see the uploaded files."),
  );
}

/** URLs of every stimulus in a folder (and its subfolders), sorted by name. */
export function stimuliIn(folder) {
  const prefix = folder.replace(/\/?$/, "/");
  const urls = names.filter((n) => n.startsWith(prefix)).map((n) => files[n]);
  if (urls.length === 0) throw new Error(`There are no stimuli in ${prefix}.`);
  return urls;
}

/** Names (not URLs) of every stimulus in a folder, sorted: record these in data, pass stimulus(name) to plugins. */
export function stimulusNamesIn(folder) {
  const prefix = folder.replace(/\/?$/, "/");
  const found = names.filter((n) => n.startsWith(prefix));
  if (found.length === 0) throw new Error(`There are no stimuli in ${prefix}.`);
  return found;
}

/** The stimulus name for a URL (or the URL itself if it isn't one). */
export function fileName(url) {
  return names.find((n) => files[n] === url) ?? url;
}

/** Adds stimulus_name to a data row whose stimulus is an uploaded file (URLs are content hashes). */
export function nameStimulus(row) {
  const s = row?.stimulus;
  if (typeof s === "string" && s in byUrl) row.stimulus_name = byUrl[s];
  else if (Array.isArray(s) && s.some((x) => x in byUrl)) row.stimulus_name = s.map((x) => byUrl[x] ?? x);
  return row;
}
const byUrl = Object.fromEntries(Object.entries(files).map(([name, url]) => [url, name]));

/** Every stimulus URL, grouped for jsPsych's preload plugin. */
export function allStimuli() {
  const pick = (pattern) => names.filter((n) => pattern.test(n)).map((n) => files[n]);
  return { images: pick(IMAGE), audio: pick(AUDIO), video: pick(VIDEO) };
}
