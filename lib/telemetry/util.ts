/** Small helpers the telemetry modules share. Pure, never throw. */

/** The promise's value, or null once `ms` pass first. A rejection is null too. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise.catch(() => null), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
