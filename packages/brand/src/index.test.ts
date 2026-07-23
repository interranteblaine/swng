import { describe, expect, it } from "vitest";
import { brandColors, brandFonts } from "./index";

describe("@swng/brand", () => {
  it("exposes the eight brand colors as 6-digit hex", () => {
    expect(Object.keys(brandColors)).toHaveLength(8);
    for (const value of Object.values(brandColors)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("exposes the serif and mono font stacks", () => {
    expect(brandFonts.serif).toContain("Georgia");
    expect(brandFonts.mono).toContain("Courier");
  });
});
