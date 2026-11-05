import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const release = JSON.parse(await readFile(path.join(root, 'packages/genomics-parser/release.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(root, 'packages/genomics-parser/package.json'), 'utf8'));
const appJson = JSON.parse(await readFile(path.join(root, 'mutant-mcp/package.json'), 'utf8'));
if (packageJson.version !== release.version) throw new Error('Parser source version differs from release.');
if (appJson.dependencies['@mutant/genomics-parser'] !== `file:vendor/${release.artifact}`) {
  throw new Error('MCP dependency does not pin the parser release artifact.');
}
const digest = async (filename) => createHash('sha256').update(await readFile(filename)).digest('hex');
for (const filename of [
  path.join(root, 'packages/genomics-parser', release.artifact),
  path.join(root, 'mutant-mcp/vendor', release.artifact),
]) {
  if (await digest(filename) !== release.sha256) throw new Error(`Parser artifact mismatch: ${filename}`);
}
console.log(`shared parser ${release.version}: artifact verified`);
