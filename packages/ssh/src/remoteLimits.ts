// Budgets shared by the POSIX and Windows remote scripts.
export const DEFAULT_REMOTE_PORT = 3773;
export const REMOTE_PORT_SCAN_WINDOW = 200;
export const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
export const REMOTE_READY_TIMEOUT_MS = 60_000;
export const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;
// Cold archive launches download and extract ~70 MB and may wait on an install lock.
// Lock waits must outlast both downloads and extraction; SSH must outlast install or wait plus readiness.
// Leave slack for verification and extraction, which have no timeout.
export const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;
export const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;
export const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;
export const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;
