'use strict';

// Opens and returns the SQLite database connection.
// Uses Node 24's built-in node:sqlite — no npm package required.
//
// This module is a singleton: the first call opens the file;
// every subsequent call returns the same connection.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');
const config = require('../config');

let db = null;

function getDb() {
  if (db) return db;

  // Resolve the path relative to wherever the process is running from.
  // If DATABASE_PATH is absolute it's used as-is; if relative it resolves
  // from the current working directory (project root when using npm scripts).
  const dbPath = path.resolve(config.databasePath);
  const dbDir  = path.dirname(dbPath);

  // Create the data/ directory if it doesn't exist yet
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new DatabaseSync(dbPath);

  // SQLite doesn't enforce foreign keys by default — turn it on per-connection
  db.exec('PRAGMA foreign_keys = ON;');

  return db;
}

module.exports = { getDb };
