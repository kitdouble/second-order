// Print feedback notes assistants left with leave_feedback (same as the list_feedback tool).
//   npm run feedback -- [--status open|resolved|wontfix|all] [--limit 50]
import { parseArgs } from 'node:util';
import { listFeedback } from '../server/feedback.js';

const { values } = parseArgs({ options: { status: { type: 'string', default: 'open' }, limit: { type: 'string', default: '50' } } });
console.log(JSON.stringify(listFeedback({ status: values.status, limit: Number(values.limit) }), null, 2));
