export class TimeoutError extends Error {}

export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
