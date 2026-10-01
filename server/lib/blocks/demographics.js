import surveyHtmlForm from "@jspsych/plugin-survey-html-form";
import "./demographics.css";

// The lab's standard demographic questions. Keep the wording and the saved
// values the same across studies so the data can be combined.

const GENDERS = [
  ["male", "Male"],
  ["female", "Female"],
  ["non_binary", "Non-binary/Gender diverse"],
  ["prefer_not_to_say", "Prefer not to say"],
];

const ENGLISH = [
  ["yes", "Yes"],
  ["no", "No"],
];

const radios = (name, options) =>
  options
    .map(([value, label]) => `<label class="demo-option"><input type="radio" name="${name}" value="${value}" required> ${label}</label>`)
    .join("");

/**
 * Age, gender and English as a first language on one page. Saved as the
 * columns `age` (a number), `gender` (male, female, non_binary or
 * prefer_not_to_say) and `english_first_language` (yes or no).
 */
export function demographics() {
  return {
    name: "Demographics",
    type: surveyHtmlForm,
    preamble: "<h2 class=\"demo-title\">About you</h2>",
    html: `
<div class="demo-form">
  <fieldset class="demo-question">
    <legend>1. What is your age?</legend>
    <label class="demo-age">
      <input type="number" name="age" min="16" max="100" step="1" inputmode="numeric" required> years
    </label>
  </fieldset>

  <fieldset class="demo-question">
    <legend>2. Gender</legend>
    ${radios("gender", GENDERS)}
  </fieldset>

  <fieldset class="demo-question">
    <legend>3. Is English your first language?</legend>
    ${radios("english_first_language", ENGLISH)}
  </fieldset>
</div>`,
    button_label: "Continue",
    // Save each answer as its own column instead of one "response" object.
    save_trial_parameters: { html: false, preamble: false },
    on_finish: (data) => {
      // No response when the run is stopped on this page (e.g. withdrawing).
      if (!data.response) return;
      const { age, gender, english_first_language } = data.response;
      data.age = Number(age);
      data.gender = gender;
      data.english_first_language = english_first_language;
      delete data.response;
    },
  };
}
