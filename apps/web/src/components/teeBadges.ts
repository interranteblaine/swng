export const TEE_COLORS = ["Blue", "White", "Red", "Gold"] as const;
export type TeeColor = (typeof TEE_COLORS)[number];

export const teeBadgeClasses: Record<string, string> = {
  Blue: "bg-blue-600 text-white",
  Red: "bg-red-600 text-white",
  White: "bg-white text-gray-800 border border-gray-300",
  Gold: "bg-amber-500 text-white",
};
