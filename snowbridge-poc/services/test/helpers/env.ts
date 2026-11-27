type Env = Record<string, string | undefined>;

// The variable names `read` asks of its env, whatever it does with the answers.
export function envNamesRead(read: (env: Env) => unknown, base: Env): string[] {
  const seen = new Set<string>();
  const spy = new Proxy(base, {
    get(target, name) {
      if (typeof name === "string") seen.add(name);
      return target[name as string];
    },
  });
  read(spy);
  return [...seen];
}
