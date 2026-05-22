'use strict';

// Handles: /watercooler admin test-run
//
// Identical to `admin run` in every way — real DMs, real calendar suggestions,
// real booking buttons, real Teams links. The only difference is a 🧪 note on
// every message asking participants to click through and test the full flow,
// with a note that no actual meeting is required and they can delete the DM.
//
// Use this for a full end-to-end system test before going live.
//
// Affected messages:
//   • Intro DM             — appends a please-test-the-booking-flow note
//   • Calendar suggestions — adds a 🧪 note to the context block
//   • Channel announcement — prefixed with 🧪 [Test run]

const run = require('./run');

async function testRun(command, respond, client) {
  await run(command, respond, client, { testMode: true });
}

module.exports = testRun;
