import { describe, expect, it } from "vitest";
import { checkMigrationNames } from "./rules.ts";

describe("checkMigrationNames", () => {
  it("accepts names numbered from 0001 per major", () => {
    const names = ["00_0001_a", "00_0002_b", "01_0001_c", "99_0001_d"];
    const checkNames = () => {
      checkMigrationNames(names);
    };
    expect(checkNames).not.toThrow();
  });

  it("names every invalid, missing and duplicate migration", () => {
    const names = [
      "100_0001_wide_major",
      "0_0001_short_major",
      "00_00001_wide_sequence",
      "00_0001_Upper",
      "00_0000_zero",
      "00-0001-kebab",
      "00_0002_a",
      "01_0002_gap",
      "01_0003_twin",
      "01_0003_other_twin",
    ];
    const problems = [
      '"100_0001_wide_major" is not XX_YYYY_migration_name',
      '"0_0001_short_major" is not XX_YYYY_migration_name',
      '"00_00001_wide_sequence" is not XX_YYYY_migration_name',
      '"00_0001_Upper" is not XX_YYYY_migration_name',
      '"00-0001-kebab" is not XX_YYYY_migration_name',
      "00_0000_zero breaks the sequence: major 00 starts at 00_0001",
      "00_0002_a breaks the sequence: expected 00_0001 after 00_0000_zero",
      "01_0002_gap breaks the sequence: major 01 starts at 01_0001",
      "01_0003_twin breaks the sequence: 01_0003_other_twin has the same number",
    ];
    const message = `invalid migration names:\n${problems.join("\n")}`;
    const checkNames = () => {
      checkMigrationNames(names);
    };
    expect(checkNames).toThrow(message);
  });
});
