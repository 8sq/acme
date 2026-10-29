// Fixed widths: Kysely sorts pending migrations as strings, not numbers.
const namePattern = /^(\d{2})_(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*$/u;

const getProblemsInMajor = (major: string, names: readonly string[]) => {
  const problems: string[] = [];
  const bySequence = Map.groupBy(names, (name) => Number(name.slice(3, 7)));
  const last = Math.max(...bySequence.keys());
  for (let sequence = 1; sequence <= last; sequence += 1) {
    const prefix = `${major}_${String(sequence).padStart(4, "0")}`;
    const sequenceNames = bySequence.get(sequence) ?? [];
    if (sequenceNames.length === 0) {
      problems.push(`${prefix} is missing`);
    } else if (sequenceNames.length > 1) {
      problems.push(`${prefix} is taken by ${sequenceNames.join(", ")}`);
    }
  }
  return problems;
};

export const checkMigrationNames = (names: readonly string[]) => {
  const invalidNames = names.filter((name) => !namePattern.test(name));
  const validNames = names.filter((name) => namePattern.test(name));
  const problems = invalidNames.map((name) => {
    return `"${name}" is not NN_NNNN_migration_name`;
  });
  const byMajor = Map.groupBy(validNames, (name) => name.slice(0, 2));
  for (const [major, majorNames] of byMajor) {
    const majorProblems = getProblemsInMajor(major, majorNames);
    problems.push(...majorProblems);
  }

  if (problems.length > 0) {
    const message = `invalid migration names:\n${problems.join("\n")}`;
    throw new Error(message);
  }
};
