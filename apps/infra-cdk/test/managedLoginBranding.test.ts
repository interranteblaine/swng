import { describe, expect, it } from "vitest";
import { brandColors } from "@swng/brand";
import { managedLoginAssets, managedLoginSettings } from "../lib/managedLoginBranding.js";

const rgba = (hex: string): string => `${hex.replace("#", "")}ff`;

describe("managed-login branding is built from @swng/brand", () => {
  it("forces light mode (the brand is light-only)", () => {
    expect(managedLoginSettings.categories.global.colorSchemeMode).toBe("LIGHT");
  });

  it("paints the page cream and the form card", () => {
    expect(managedLoginSettings.components.pageBackground.lightMode.color).toBe(rgba(brandColors.cream));
    expect(managedLoginSettings.components.form.lightMode.backgroundColor).toBe(rgba(brandColors.card));
  });

  it("makes the primary button gold with forest text (the one pencil)", () => {
    const btn = managedLoginSettings.components.primaryButton.lightMode.defaults;
    expect(btn.backgroundColor).toBe(rgba(brandColors.gold));
    expect(btn.textColor).toBe(rgba(brandColors.forest));
  });

  it("uses oxblood for input placeholders (the second ink)", () => {
    expect(managedLoginSettings.componentClasses.input.lightMode.placeholderColor).toBe(rgba(brandColors.oxblood));
  });

  it("squares every corner", () => {
    expect(managedLoginSettings.componentClasses.buttons.borderRadius).toBe(0);
    expect(managedLoginSettings.componentClasses.input.borderRadius).toBe(0);
    expect(managedLoginSettings.components.form.borderRadius).toBe(0);
    expect(managedLoginSettings.components.alert.borderRadius).toBe(0);
  });

  it("ships one FORM_LOGO SVG carrying the forest wordmark", () => {
    expect(managedLoginAssets).toHaveLength(1);
    const logo = managedLoginAssets[0]!;
    expect(logo.category).toBe("FORM_LOGO");
    expect(logo.colorMode).toBe("LIGHT");
    expect(logo.extension).toBe("SVG");
    const svg = Buffer.from(logo.bytes as string, "base64").toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("swng");
    expect(svg).toContain(brandColors.forest);
  });
});
