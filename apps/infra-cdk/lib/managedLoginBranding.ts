import { brandColors } from "@swng/brand";
import type { CfnManagedLoginBranding } from "aws-cdk-lib/aws-cognito";

// Cognito's managed-login Settings encode colors as RRGGBBAA (8 hex, no '#'). The brand is fully
// opaque, so each token maps to <rrggbb>ff. ONE conversion — the login's colors ARE the @swng/brand
// tokens, never a second copy.
const rgba = (hex: string): string => `${hex.replace("#", "")}ff`;

const c = brandColors;

// A PARTIAL Settings document — Cognito merges its own defaults for everything we don't specify
// (AWS docs: "preserves existing style settings that you don't specify"). Light-mode only: the brand
// is light-only (owner call), so colorSchemeMode LIGHT forces it and we set only lightMode values.
// Every borderRadius is 0 (the square-corners principle). Button states DON'T flip color on hover
// (faithful to the app: recolor/retype/re-shape, never re-behave). Gold is the ONE primary fill
// (the pencil); oxblood is placeholders + errors (the second ink).
export const managedLoginSettings = {
  categories: {
    global: { colorSchemeMode: "LIGHT", spacingDensity: "REGULAR" },
    form: { location: { horizontal: "CENTER", vertical: "CENTER" } },
  },
  componentClasses: {
    buttons: { borderRadius: 0 },
    input: {
      borderRadius: 0,
      lightMode: {
        defaults: { backgroundColor: rgba(c.card), borderColor: rgba(c.hairline) },
        placeholderColor: rgba(c.oxblood),
      },
    },
    dropDown: { borderRadius: 0 },
    inputLabel: { lightMode: { textColor: rgba(c.forest) } },
    inputDescription: { lightMode: { textColor: rgba(c.fairway) } },
    link: { lightMode: { defaults: { textColor: rgba(c.fairway) }, hover: { textColor: rgba(c.forest) } } },
    focusState: { lightMode: { borderColor: rgba(c.forest) } },
    divider: { lightMode: { borderColor: rgba(c.hairline) } },
  },
  components: {
    pageBackground: { image: { enabled: false }, lightMode: { color: rgba(c.cream) } },
    form: {
      borderRadius: 0,
      backgroundImage: { enabled: false },
      lightMode: { backgroundColor: rgba(c.card), borderColor: rgba(c.hairline) },
      logo: { enabled: true, formInclusion: "IN", location: "CENTER", position: "TOP" },
    },
    pageText: {
      lightMode: { bodyColor: rgba(c.forest), headingColor: rgba(c.forest), descriptionColor: rgba(c.fairway) },
    },
    primaryButton: {
      lightMode: {
        defaults: { backgroundColor: rgba(c.gold), textColor: rgba(c.forest) },
        hover: { backgroundColor: rgba(c.gold), textColor: rgba(c.forest) },
        active: { backgroundColor: rgba(c.gold), textColor: rgba(c.forest) },
        disabled: { backgroundColor: rgba(c.hairline), borderColor: rgba(c.hairline) },
      },
    },
    secondaryButton: {
      lightMode: {
        defaults: { backgroundColor: rgba(c.card), borderColor: rgba(c.forest), textColor: rgba(c.forest) },
        hover: { backgroundColor: rgba(c.cream), borderColor: rgba(c.forest), textColor: rgba(c.forest) },
        active: { backgroundColor: rgba(c.cream), borderColor: rgba(c.forest), textColor: rgba(c.forest) },
      },
    },
    alert: { borderRadius: 0, lightMode: { error: { backgroundColor: rgba(c.cream), borderColor: rgba(c.oxblood) } } },
  },
} as const;

// The "swng" wordmark on the form card — forest text (from @swng/brand), transparent ground, the
// app's own font-less system-sans wordmark. Only Cognito-allowed SVG elements/attributes
// (svg/text; fill/font-*/x/y/width/height/viewBox). base64 into the asset Bytes.
const wordmarkSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48">` +
  `<text x="0" y="37" font-family="-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif" ` +
  `font-size="42" font-weight="700" fill="${c.forest}">swng</text></svg>`;

export const managedLoginAssets: CfnManagedLoginBranding.AssetTypeProperty[] = [
  {
    category: "FORM_LOGO",
    colorMode: "LIGHT",
    extension: "SVG",
    bytes: Buffer.from(wordmarkSvg, "utf8").toString("base64"),
  },
];
