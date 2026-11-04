import { describe, expect, it } from "vitest";
import { checkMigrationNames, compareMigrationNames } from "./rules.ts";

describe("checkMigrationNames", () => {
  it("accepts names numbered from 0001 per major", () => {
    const names = [
      "00_0001_a",
      "00_0002_b",
      "01_0001_c",
      "99_0001_d",
      "100_0001_e",
    ];
    const checkNames = () => {
      checkMigrationNames(names);
    };
    expect(checkNames).not.toThrow();
  });

  it("names every invalid, missing and duplicate migration", () => {
    const names = [
      "001_0001_padded_major",
      "0143_0001_padded_wide_major",
      "0_0001_short_major",
      "00_00001_wide_sequence",
      "00_0001_Upper",
      "00_0000_zero",
      "00-0001-kebab",
      "00_0002_a",
      "01_0002_gap",
      "01_0003_twin",
      "01_0003_other_twin",
      "100_0002_gap",
    ];
    const problems = [
      '"001_0001_padded_major" is not XX_YYYY_migration_name',
      '"0143_0001_padded_wide_major" is not XX_YYYY_migration_name',
      '"0_0001_short_major" is not XX_YYYY_migration_name',
      '"00_00001_wide_sequence" is not XX_YYYY_migration_name',
      '"00_0001_Upper" is not XX_YYYY_migration_name',
      '"00-0001-kebab" is not XX_YYYY_migration_name',
      "00_0000_zero breaks the sequence: major 00 starts at 00_0001",
      "00_0002_a breaks the sequence: expected 00_0001 after 00_0000_zero",
      "01_0002_gap breaks the sequence: major 01 starts at 01_0001",
      "01_0003_twin breaks the sequence: 01_0003_other_twin has the same number",
      "100_0002_gap breaks the sequence: major 100 starts at 100_0001",
    ];
    const message = `invalid migration names:\n${problems.join("\n")}`;
    const checkNames = () => {
      checkMigrationNames(names);
    };
    expect(checkNames).toThrow(message);
  });
});

describe("compareMigrationNames", () => {
  it("orders by major, then sequence, as numbers", () => {
    const names = [
      "143_0001_e",
      "100_0001_c",
      "142_0001_d",
      "99_0002_b",
      "99_0001_a",
      "09_0010_z",
    ];

    expect(names.toSorted(compareMigrationNames)).toEqual([
      "09_0010_z",
      "99_0001_a",
      "99_0002_b",
      "100_0001_c",
      "142_0001_d",
      "143_0001_e",
    ]);
  });
});
