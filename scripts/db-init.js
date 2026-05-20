'use strict';

// Standalone script: initialise the database without starting the server.
// Usage:  npm run db:init
//
// This is safe to run multiple times — all CREATE TABLE statements use
// IF NOT EXISTS, so re-running it won't touch existing data.

const { initDb } = require('../src/db/init');

console.log('Initialising Watercooler database...');
initDb();
