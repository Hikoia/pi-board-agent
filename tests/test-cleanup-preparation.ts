import { cleanupBoundaryChecks } from "./cleanup-boundary-checks.js";
import { dispose } from "./cleanup-fixture.js";
try { await cleanupBoundaryChecks("ignored clean"); } finally { dispose(); }
