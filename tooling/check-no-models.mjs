#!/usr/bin/env node
// Compatibility entry point for CLI packages and existing publication scripts.
import { verifyModelBuild } from './public-models.mjs';
const roots = process.argv.slice(2);
if (!roots.length) { console.error('Usage: check-no-models.mjs <directory>…'); process.exit(2); }

try {
  for (const root of roots) {
    const files = verifyModelBuild(root);
    console.log(`Verified ${files.length} licensed public model files in ${root}.`);
  }
} catch (error) {
  console.error(`Refusing to publish: ${error.message}`);
  process.exit(1);
}
