'use strict';

const fs = require('fs');
const path = require('path');

const testDir = __dirname;
const testFiles = fs.readdirSync(testDir)
  .filter(name => name.endsWith('.test.js'))
  .sort();

for (const file of testFiles) {
  require(path.join(testDir, file));
}
