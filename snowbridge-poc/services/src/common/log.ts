export type Fields = Record<string, unknown>;

export type Logger = {
  info: (message: string, fields?: Fields) => void;
  warn: (message: string, fields?: Fields) => void;
  error: (message: string, fields?: Fields) => void;
};

function emit(level: string, message: string, fields: Fields = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  (level === "info" ? console.log : console.error)(line);
}

export const consoleLogger: Logger = {
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields),
};
