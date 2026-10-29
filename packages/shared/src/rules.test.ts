import { describe, expect, it } from "vitest";
import { checkMigrationNames } from "./rules.ts";

describe("checkMigrationNames", () => {
  it("accepts names numbered from 0001 per major", () => {
    const names = ["0000_0001_a", "0000_0002_b", "0001_0001_c", "0099_0001_d"];
    const checkNames = () => {
      checkMigrationNames(names);
    };
    expect(checkNames).not.toThrow();
  });

  it("names every invalid, missing and duplicate migration", () => {
    const names = [
      "10000_0001_wide_major",
      "100_0001_short_major",
      "0000_00001_wide_sequence",
      "0000_0001_Upper",
      "0000_0000_zero",
      "0000-0001-kebab",
      "0000_0002_a",
      "0001_0002_gap",
      "0001_0003_twin",
      "0001_0003_other_twin",
    ];
    const problems = [
      '"10000_0001_wide_major" is not XXXX_YYYY_migration_name',
      '"100_0001_short_major" is not XXXX_YYYY_migration_name',
      '"0000_00001_wide_sequence" is not XXXX_YYYY_migration_name',
      '"0000_0001_Upper" is not XXXX_YYYY_migration_name',
      '"0000-0001-kebab" is not XXXX_YYYY_migration_name',
      "0000_0000_zero breaks the sequence: major 0000 starts at 0000_0001",
      "0000_0002_a breaks the sequence: expected 0000_0001 after 0000_0000_zero",
      "0001_0002_gap breaks the sequence: major 0001 starts at 0001_0001",
      "0001_0003_twin breaks the sequence: 0001_0003_other_twin has the same number",
    ];
    const message = `invalid migration names:\n${problems.join("\n")}`;
    const checkNames = () => {
      checkMigrationNames(names);
    };
    expect(checkNames).toThrow(message);
  });
});
