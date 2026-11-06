/**
 * A stand-in for the Antigravity CLI, for test/ask.test.mjs.
 *
 * It records what it was started with (argv, cwd, what is in cwd, the session
 * settings file, stdin) to FAKE_AGY_RECORD, then behaves as FAKE_AGY_MODE says,
 * printing the same stream-json shapes agy 1.4.11 printed on 2026-11-06.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const mode = process.env.FAKE_AGY_MODE || 'ok';
const recordFile = process.env.FAKE_AGY_RECORD;
const argv = process.argv.slice(2);

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const step = (i, extra) => emit({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: i, ...extra } });
const result = (r) => emit({ event: 'result', result: { conversation_id: 'c1', ...r } });

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  const at = argv.indexOf('--settings');
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(argv[at + 1], 'utf8'));
  } catch {
    /* recorded as null */
  }
  const record = { argv, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), settings, stdin, pid: process.pid };
  if (recordFile) fs.writeFileSync(recordFile, JSON.stringify(record));
  run();
});

function run() {
  emit({ event: 'init', conversation_id: 'c1', init: { model: 'fake', cwd: process.cwd(), tools: ['search_web'], permission_mode: 'strict' } });
  step(0, { state: 'DONE', step_type: 'user_input' });
  switch (mode) {
    case 'ok': {
      step(1, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello \x1b[31mred\x1b[0m ' });
      step(1, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'world\x07\x00\u202e!' });
      result({ status: 'SUCCESS', response: 'Hello \x1b[31mred\x1b[0m world\x07\x00\u202e!\r\n- one\r\n- two' });
      process.exit(0);
      break;
    }
    case 'long': {
      const big = 'x'.repeat(50_000);
      step(1, { state: 'ACTIVE', step_type: 'agent_response', text_delta: big });
      result({ status: 'SUCCESS', response: big });
      process.exit(0);
      break;
    }
    case 'auth': {
      process.stderr.write('error: not signed in. Please sign in with `agy` first.\n');
      process.exit(1);
      break;
    }
    case 'quota': {
      // The step agy 1.4.11 wrote before its failed result (seen in the quota run).
      step(1, { state: 'DONE', step_type: 'error_message' });
      result({ status: 'ERROR', response: '', error: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 35m21s.' });
      process.stderr.write('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429)","status":"RESOURCE_EXHAUSTED","error_code":429}\n');
      process.exit(3);
      break;
    }
    case 'secret': {
      process.stderr.write('panic at C:\\Users\\secret-user\\AppData\\Local\\agy\\x.go token=hunter2\n');
      result({ status: 'ERROR', response: '', error: 'C:\\Users\\secret-user\\boom' });
      process.exit(1);
      break;
    }
    case 'tool': {
      step(1, { state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command' } });
      setInterval(() => undefined, 1000);
      break;
    }
    // Each of these reports something off the allowlist, then would go on to
    // answer: the answer must never arrive.
    case 'unknownstep':
    case 'browserstep':
    case 'browsertool':
    case 'unknownevent':
    case 'notjson': {
      if (mode === 'unknownstep') step(1, { state: 'ACTIVE', step_type: 'planner_magic' });
      if (mode === 'browserstep') step(1, { state: 'ACTIVE', step_type: 'browser_subagent' });
      if (mode === 'browsertool') step(1, { state: 'ACTIVE', step_type: 'tool', tool_name: 'open_browser_url' });
      if (mode === 'unknownevent') emit({ event: 'control_request', request: { kind: 'x' } });
      if (mode === 'notjson') process.stdout.write('some stray text that is not an event\n');
      setTimeout(() => {
        step(2, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'LEAKED ANSWER' });
        result({ status: 'SUCCESS', response: 'LEAKED ANSWER' });
        process.exit(0);
      }, 1500);
      break;
    }
    case 'search': {
      step(1, { state: 'ACTIVE', step_type: 'tool', tool_name: 'search_web' });
      step(1, { state: 'DONE', step_type: 'tool', tool_name: 'search_web' });
      step(2, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'found it' });
      result({ status: 'SUCCESS', response: 'found it' });
      process.exit(0);
      break;
    }
    case 'sleep': {
      // A grandchild too, so the test can prove the whole tree dies.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      if (process.env.FAKE_AGY_GRANDCHILD) fs.writeFileSync(process.env.FAKE_AGY_GRANDCHILD, String(child.pid));
      setInterval(() => undefined, 1000);
      break;
    }
    default:
      process.exit(9);
  }
}
void path;
