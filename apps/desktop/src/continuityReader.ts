import { runObservedCliArchiveReader } from '@extalia/host/continuity-reader';

process.exitCode = await runObservedCliArchiveReader(process.argv.slice(2));
