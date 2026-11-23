// The study length an experiment states in consent({ minutes }), read from its code. It sets the
// Prolific pay and is compared with measured completion times, so create_prolific_draft, check_launch
// and quality_report all read it the same way.

const NUMBER = /^\d+(?:\.\d+)?$/;

/**
 * { minutes, expression } for the first consent({ minutes }) call: minutes is the number, or null when
 * it can't be worked out; expression is what the code passes (null when there is no minutes at all).
 * Handles a literal (minutes: 12), a top-level constant (minutes: STUDY_MINUTES with
 * const STUDY_MINUTES = 12) and shorthand (consent({ minutes }) with const minutes = 12).
 */
export function statedMinutes(code = '') {
  const call = code.match(/consent\(\s*\{([^}]*)\}/);
  if (!call) return { minutes: null, expression: null };
  const args = call[1];
  const named = args.match(/(?:^|[,{\s])minutes\s*:\s*([^,}\n]+)/);
  const shorthand = !named && /(?:^|[,\s])minutes\s*(?:,|$)/.test(args);
  if (!named && !shorthand) return { minutes: null, expression: null };
  const expression = shorthand ? 'minutes' : named[1].trim();
  return { minutes: resolve(code, expression), expression };
}

function resolve(code, expression, depth = 0) {
  if (NUMBER.test(expression)) return Number(expression) || null;
  if (depth > 3 || !/^[A-Za-z_$][\w$]*$/.test(expression)) return null;
  const decl = code.match(new RegExp(`(?:^|[;\\n])\\s*(?:export\\s+)?(?:const|let|var)\\s+${expression.replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]+)`));
  return decl ? resolve(code, decl[1].trim(), depth + 1) : null;
}
