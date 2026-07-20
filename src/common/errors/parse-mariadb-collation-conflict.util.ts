export type MariaDbCollationConflict = {
  leftCollation: string;
  leftCoercibility: string;
  rightCollation: string;
  rightCoercibility: string;
  operation: string;
};

const MAX_GRAPH_NODES = 6;
const MAX_MESSAGE_LENGTH = 2048;
const COLLATION_TOKEN_LENGTH = 64;
const COERCIBILITY_TOKEN_LENGTH = 32;
const OPERATION_TOKEN_LENGTH = 32;

const COLLATION_CONFLICT_PATTERN = new RegExp(
  String.raw`Illegal\s+mix\s+of\s+collations\s*\(\s*([A-Za-z0-9_]{1,${COLLATION_TOKEN_LENGTH}})\s*,\s*([A-Za-z0-9_]{1,${COERCIBILITY_TOKEN_LENGTH}})\s*\)\s*(?:and|,)\s*\(\s*([A-Za-z0-9_]{1,${COLLATION_TOKEN_LENGTH}})\s*,\s*([A-Za-z0-9_]{1,${COERCIBILITY_TOKEN_LENGTH}})\s*\)\s*for\s+operation\s*(?:'([A-Za-z0-9_]{1,${OPERATION_TOKEN_LENGTH}})'|"([A-Za-z0-9_]{1,${OPERATION_TOKEN_LENGTH}})"|\x60([A-Za-z0-9_]{1,${OPERATION_TOKEN_LENGTH}})\x60|([A-Za-z0-9_]{1,${OPERATION_TOKEN_LENGTH}}))\s*$`,
  "i",
);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectBoundedErrorRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<object>();

  while (queue.length > 0 && records.length < MAX_GRAPH_NODES) {
    const candidate = queue.shift();
    const record = asRecord(candidate);
    if (record === undefined || seen.has(record)) {
      continue;
    }

    seen.add(record);
    records.push(record);
    queue.push(record.cause, record.driverAdapterError);
  }

  return records;
}

function isError1267(records: Record<string, unknown>[]): boolean {
  return records.some((record) =>
    [record.originalCode, record.code].some(
      (code) => code === 1267 || code === "1267",
    ),
  );
}

function parseMessage(message: unknown): MariaDbCollationConflict | undefined {
  if (
    typeof message !== "string" ||
    message.length === 0 ||
    message.length > MAX_MESSAGE_LENGTH
  ) {
    return undefined;
  }

  const match = COLLATION_CONFLICT_PATTERN.exec(message);
  if (match === null) {
    return undefined;
  }

  const leftCollation = match[1];
  const leftCoercibility = match[2];
  const rightCollation = match[3];
  const rightCoercibility = match[4];
  const operation = match[5] ?? match[6] ?? match[7] ?? match[8];
  if (
    leftCollation === undefined ||
    leftCoercibility === undefined ||
    rightCollation === undefined ||
    rightCoercibility === undefined ||
    operation === undefined
  ) {
    return undefined;
  }

  return {
    leftCollation: leftCollation.toLowerCase(),
    leftCoercibility: leftCoercibility.toUpperCase(),
    rightCollation: rightCollation.toLowerCase(),
    rightCoercibility: rightCoercibility.toUpperCase(),
    operation: operation.toLowerCase(),
  };
}

/**
 * Parses only the bounded collation tokens from a MariaDB 1267 error. Raw
 * messages are inspected in memory and are never returned to callers.
 */
export function parseMariaDbCollationConflict(
  error: unknown,
): MariaDbCollationConflict | undefined {
  const records = collectBoundedErrorRecords(error);
  if (!isError1267(records)) {
    return undefined;
  }

  for (const record of records) {
    const parsed =
      parseMessage(record.originalMessage) ?? parseMessage(record.message);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}
