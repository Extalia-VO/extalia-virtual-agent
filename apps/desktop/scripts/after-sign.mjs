/** Scanner native files were pre-signed; outer signing must preserve every pinned byte. */
import { verifyPackagedScanner } from './after-pack.mjs';

export default async function afterSign(context) {
  // Electron signs the daemon itself after afterPack; its original artifact hash
  // is checked there. Its scanner bundle remains byte-for-byte pinned here.
  await verifyPackagedScanner(context, false);
}
