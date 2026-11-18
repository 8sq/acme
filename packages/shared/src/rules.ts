// Majors past 99 never start with 0, so each major has one spelling.
const namePattern = /^(?:\d{2}|[1-9]\d{2,})_\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/u;

const getMajorPrefix = (name: string) => {
  return name.slice(0, name.indexOf("_"));
};

/**
 * The major of a `XX_YYYY_migration_name`, as a number.
 */
export const getMigrationMajor = (name: string) => {
  return Number(getMajorPrefix(name));
};

/**
 * The sequence (YYYY) of a `XX_YYYY_migration_name`, as a number.
 */
export const getMigrationSequence = (name: string) => {
  const start = name.indexOf("_") + 1;
  return Number(name.slice(start, start + 4));
};

/**
 * Orders migration names by major, then sequence, as numbers.
 */
export const compareMigrationNames = (first: string, second: string) => {
  const majorOrder = getMigrationMajor(first) - getMigrationMajor(second);
  if (majorOrder !== 0) return majorOrder;

  const sequenceOrder =
    getMigrationSequence(first) - getMigrationSequence(second);
  if (sequenceOrder !== 0) return sequenceOrder;

  if (first === second) return 0;
  return first < second ? -1 : 1;
};

// `previous` is the name before this one in its major, if any.
const getSequenceProblem = (name: string, previous: string | undefined) => {
  const major = getMajorPrefix(name);
  const sequence = getMigrationSequence(name);
  if (previous === undefined) {
    const startsAtOne = sequence === 1;
    const problem = `${name} breaks the sequence: major ${major} starts at ${major}_0001`;
    return startsAtOne ? undefined : problem;
  }

  const previousSequence = getMigrationSequence(previous);
  if (sequence === previousSequence) {
    return `${name} breaks the sequence: ${previous} has the same number`;
  }

  const isNext = sequence === previousSequence + 1;
  const expected = `${major}_${String(previousSequence + 1).padStart(4, "0")}`;
  const problem = `${name} breaks the sequence: expected ${expected} after ${previous}`;
  return isNext ? undefined : problem;
};

/**
 * Throws, listing every problem, unless all are `XX_YYYY_migration_name`.
 *
 * Names use lower case letters, digits and `_`. Within each major, sequences
 * run from `0001` with no gap or duplicate. Majors past 99 have no leading 0.
 */
export const checkMigrationNames = (names: readonly string[]) => {
  const invalidNames = names.filter((name) => !namePattern.test(name));
  const validNames = names.filter((name) => namePattern.test(name));
  const sortedNames = validNames.toSorted(compareMigrationNames);
  const problems = invalidNames.map((name) => {
    return `"${name}" is not XX_YYYY_migration_name`;
  });

  for (const [index, name] of sortedNames.entries()) {
    const before = sortedNames[index - 1];
    const isSameMajor =
      before !== undefined && getMajorPrefix(before) === getMajorPrefix(name);
    const problem = getSequenceProblem(name, isSameMajor ? before : undefined);
    if (problem !== undefined) problems.push(problem);
  }

  if (problems.length > 0) {
    const message = `invalid migration names:\n${problems.join("\n")}`;
    throw new Error(message);
  }
};
