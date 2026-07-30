import { describe, expect, test as it } from "bun:test";

import packageJson from "../../../package.json";

describe("Version", () => {
  it("version", () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
