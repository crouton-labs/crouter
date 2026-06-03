// crtrd entry point — spawned detached by `crtr canvas daemon start` and by bin/crtrd.
// Calls runDaemon() and never returns (the loop drives via setTimeout).
import { runDaemon } from './crtrd.js';

runDaemon();
