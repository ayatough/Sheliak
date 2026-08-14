// The executable wrapper. Everything decidable lives in `main.ts` and returns a
// result instead of writing or exiting, so the commands can be tested without a
// subprocess; this file is the only part that touches the process.

import { run } from './main.ts';

const { out, err, code } = await run(process.argv.slice(2));
if (out) console.log(out);
if (err) console.error(err);
process.exit(code);
