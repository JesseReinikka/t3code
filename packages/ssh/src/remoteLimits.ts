// Budgets shared by the POSIX and Windows remote scripts.
export const DEFAULT_REMOTE_PORT = 3773;
export const REMOTE_PORT_SCAN_WINDOW = 200;
export const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
export const REMOTE_READY_TIMEOUT_MS = 60_000;
export const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;
// A cold archive launch also downloads and unpacks a ~70 MB release archive
// and may wait on another installer's lock. The budgets nest: the checksum
// file is tiny and the archive download is bounded; a waiter outlasts both
// downloads plus extraction so it can reuse the result; and the SSH command
// outlasts an install (own or waited-for) plus readiness, with slack for
// verification and extraction, which have no timeout of their own.
export const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;
export const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;
export const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;
export const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;
