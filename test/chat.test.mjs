/**
 * Chat: cleaning, dedupe, queueing and history.
 *
 * The assertion that matters most is that a message which could NOT be
 * delivered is recorded as `queued` rather than `sent`. The relay stores
 * nothing, so a frame addressed to a peer that is not connected is discarded in
 * transit and no error is raised anywhere. A UI that showed those as sent would
 * be inventing a delivery that never happened, which is the exact failure this
 * codebase keeps having to correct in other places.
 *
 * Dedupe is the second: the source does not check sequence numbers on the up
 * channel, so a relay replaying an old frame would deliver a message twice
 * unless the id is remembered.
 *
 *   node test/chat.test.mjs
 */

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-chat-'));
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`);
  }
};

async function load(entry, stubs = {}) {
  const out = path.join(tmp, path.basename(entry, '.ts') + '.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'error',
    external: ['electron'],
    plugins: Object.keys(stubs).length
      ? [
          {
            name: 'stub',
            setup(b) {
              for (const [match, contents] of Object.entries(stubs)) {
                const re = new RegExp(match);
                b.onResolve({ filter: re }, (a) => ({ path: a.path, namespace: 'stub' }));
                b.onLoad({ filter: re, namespace: 'stub' }, () => ({ contents, loader: 'js' }));
              }
            },
          },
        ]
      : [],
  });
  return require(out);
}

const chat = await load('src/shared/chat.ts');

console.log('\ncleaning what a person typed');
{
  ok('plain text survives', chat.cleanOutgoing('hello there') === 'hello there');
  ok('surrounding space is trimmed', chat.cleanOutgoing('  hi  ') === 'hi');
  ok('an empty message is refused', chat.cleanOutgoing('   ') === null);
  ok('a non-string is refused', chat.cleanOutgoing(42) === null && chat.cleanOutgoing(null) === null);
  ok('newlines are kept, because the sender typed them',
     chat.cleanOutgoing('one\ntwo') === 'one\ntwo');
  ok('tabs are kept', chat.cleanOutgoing('a\tb') === 'a\tb');

  const withControl = 'we' + String.fromCharCode(0) + 'll' + String.fromCharCode(7);
  ok('control characters are stripped', chat.cleanOutgoing(withControl) === 'well',
     JSON.stringify(chat.cleanOutgoing(withControl)));

  const long = 'x'.repeat(chat.MAX_TEXT + 500);
  ok('an over-long message is capped, not refused',
     chat.cleanOutgoing(long).length === chat.MAX_TEXT);
}

console.log('\nvalidating what arrived from the network');
{
  const good = chat.cleanIncoming({ id: 'abc', text: 'hi', at: 1000 });
  ok('a well formed message passes', good && good.id === 'abc' && good.text === 'hi' && good.at === 1000);
  ok('no id is refused', chat.cleanIncoming({ text: 'hi', at: 1 }) === null);
  ok('no text is refused', chat.cleanIncoming({ id: 'a', at: 1 }) === null);
  ok('empty text is refused', chat.cleanIncoming({ id: 'a', text: '   ', at: 1 }) === null);
  ok('junk is refused, not thrown on',
     chat.cleanIncoming(null) === null && chat.cleanIncoming('nope') === null && chat.cleanIncoming(7) === null);
  const noAt = chat.cleanIncoming({ id: 'a', text: 'hi' });
  ok('a missing timestamp is filled rather than rejected', noAt !== null && Number.isFinite(noAt.at));
  const huge = chat.cleanIncoming({ id: 'i'.repeat(500), text: 'hi', at: 1 });
  ok('an absurd id is capped', huge !== null && huge.id.length === 64);
}

console.log('\nthreads: queueing, dedupe and history');
{
  // The store persists through ./store, which needs Electron. Stub the two
  // functions it actually calls so the logic can be tested without a window.
  const store = await load('src/main/projection/chat-store.ts', {
    'store$': `
      let saved = null;
      exports.readChatFile = async () => saved;
      exports.writeChatFile = async (v) => { saved = v; };
    `,
  });

  await store.loadChat();

  const wire = (id, text) => ({ id, text, at: Date.now() });

  const sent = store.recordOutgoing('screen-1', 'Laptop', wire('m1', 'delivered one'), true);
  ok('a delivered message is recorded as sent', sent.state === 'sent' && sent.mine === true);

  const queued = store.recordOutgoing('screen-1', 'Laptop', wire('m2', 'nobody home'), false);
  ok('an undelivered message is recorded as QUEUED, not sent', queued.state === 'queued',
     String(queued.state));
  ok('and it is held in the outbox', store.outboxSize('screen-1') === 1,
     String(store.outboxSize('screen-1')));

  const first = store.recordIncoming('screen-1', 'Laptop', wire('in1', 'hello back'));
  ok('an incoming message is recorded', first !== null && first.mine === false);
  ok('it counts as unread', store.threadOf('screen-1').unread === 1);

  const replay = store.recordIncoming('screen-1', 'Laptop', wire('in1', 'hello back'));
  ok('the SAME id arriving again is dropped', replay === null);
  ok('and the unread count did not move', store.threadOf('screen-1').unread === 1,
     String(store.threadOf('screen-1').unread));

  store.markRead('screen-1');
  ok('marking read clears the count', store.threadOf('screen-1').unread === 0);

  const taken = store.takeOutbox('screen-1');
  ok('taking the outbox returns what was waiting', taken.length === 1 && taken[0].id === 'm2');
  ok('and empties it', store.outboxSize('screen-1') === 0);

  store.markDelivered('screen-1', ['m2']);
  const m2 = store.threadOf('screen-1').messages.find((m) => m.id === 'm2');
  ok('a delivered queued message stops saying it is waiting', m2.state === 'sent', String(m2.state));

  // History cap: the thread must not grow without bound.
  for (let i = 0; i < chat.MAX_HISTORY + 40; i++) {
    store.recordIncoming('screen-2', 'Desk', wire(`bulk${i}`, `m ${i}`));
  }
  const t2 = store.threadOf('screen-2');
  ok('history is capped', t2.messages.length === chat.MAX_HISTORY, String(t2.messages.length));
  ok('and it is the OLDEST that fall off',
     t2.messages[t2.messages.length - 1].text === `m ${chat.MAX_HISTORY + 39}`,
     t2.messages[t2.messages.length - 1].text);

  store.forgetPeer('screen-1');
  ok('forgetting a peer drops its thread', store.threadOf('screen-1') === null);
  ok('and leaves other threads alone', store.threadOf('screen-2') !== null);

  store.forgetAll();
  ok('forgetting everything empties the store', store.allThreads().length === 0);
}

console.log('');
console.log('findings from the security review');
{
  const store = await load('src/main/projection/chat-store.ts', {
    'store$': `
      let saved = null;
      exports.readChatFile = async () => saved;
      exports.writeChatFile = async (v) => { saved = v; };
    `,
  });
  await store.loadChat();
  const wire = (id, text) => ({ id, text, at: Date.now() });

  // L1: stripControl walked the whole string before the cap, so a peer holding
  // the key could stall the main process with one oversized message.
  const huge = 'a'.repeat(20 * 1024 * 1024);
  const t0 = performance.now();
  const cleanedHuge = chat.cleanOutgoing(huge);
  const ms = performance.now() - t0;
  ok('a 20 MB message is cleaned in well under a second, not seconds', ms < 250, ms.toFixed(0) + ' ms');
  ok('and it is still capped correctly', cleanedHuge.length === chat.MAX_TEXT);

  const hugeControl = String.fromCharCode(0).repeat(5 * 1024 * 1024) + 'hi';
  const t1 = performance.now();
  chat.cleanIncoming({ id: 'x', text: hugeControl, at: 1 });
  const ms2 = performance.now() - t1;
  ok('a message that is almost all control characters is also bounded', ms2 < 250, ms2.toFixed(0) + ' ms');

  // L2: the cap has to evict, and what it evicts must stop claiming to be on
  // its way. That is the same lie `state` exists to prevent, one step on.
  for (let i = 0; i < chat.MAX_OUTBOX + 5; i++) {
    store.recordOutgoing('p1', 'Peer', wire('q' + i, 'queued ' + i), false);
  }
  ok('the outbox cap binds', store.outboxSize('p1') === chat.MAX_OUTBOX, String(store.outboxSize('p1')));
  const dropped = store.threadOf('p1').messages.filter((m) => m.state === 'dropped');
  ok('evicted messages are marked dropped, not left saying "waiting"', dropped.length === 5,
     dropped.length + ' marked dropped');
  ok('and the ones still queued say so',
     store.threadOf('p1').messages.filter((m) => m.state === 'queued').length === chat.MAX_OUTBOX);

  // L4: the seen set is bounded, but recent ids must still dedupe.
  for (let i = 0; i < chat.MAX_HISTORY * 3; i++) {
    store.recordIncoming('p2', 'Peer2', wire('s' + i, 'm' + i));
  }
  const lastId = 's' + (chat.MAX_HISTORY * 3 - 1);
  ok('recent ids still dedupe after heavy traffic',
     store.recordIncoming('p2', 'Peer2', wire(lastId, 'dupe')) === null);

  // L6: forgetAll must cancel the pending write, not schedule one.
  store.recordOutgoing('p3', 'Peer3', wire('keep', 'hello'), true);
  store.forgetAll();
  await new Promise((r) => setTimeout(r, 1800));
  await store.loadChat();
  ok('forgetting everything does not resurrect the file 1.5 s later',
     store.allThreads().length === 0, store.allThreads().length + ' thread(s) came back');

  // L3: labels are logged and shown in the tray, so they are cleaned too.
  ok('a label with control characters is cleaned',
     chat.cleanLabel('Lap' + String.fromCharCode(27) + 'top', 'fallback') === 'Laptop');
  ok('an empty label falls back', chat.cleanLabel('   ', 'fallback') === 'fallback');
  ok('a non-string label falls back', chat.cleanLabel(null, 'fallback') === 'fallback');
  ok('an over-long label is capped', chat.cleanLabel('z'.repeat(300), 'f').length === 40);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
