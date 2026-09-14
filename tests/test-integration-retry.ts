// Split native Git fixtures across processes; runner remains strictly serial.
import { integrationChecks } from "./integration-checks.js";
await integrationChecks("push");
