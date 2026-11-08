function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export type ProcessSignalProbe = (pid: number, signal: number) => unknown;

/** Treat EPERM as alive: the process exists, but this process cannot signal it. */
export function processIsAlive(
  pid: number,
  probe: ProcessSignalProbe = (targetPid, signal) => process.kill(targetPid, signal),
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}
