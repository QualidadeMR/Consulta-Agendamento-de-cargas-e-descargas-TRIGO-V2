const { cpSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'static');

mkdirSync(output, { recursive: true });
cpSync(path.join(root, 'public'), output, { recursive: true });
