import { useMatches, type UIMatch } from "react-router-dom";
import type { AppHandle } from "@/routes";

export function useRouteTitle(): string {
  const matches = useMatches();
  if (!matches.length) return "";

  const leaf = matches[matches.length - 1] as UIMatch & {
    handle?: AppHandle;
  };
  const maybeTitle = leaf?.handle?.title;

  if (typeof maybeTitle === "function") {
    try {
      return maybeTitle(leaf);
    } catch {
      return "";
    }
  }

  return maybeTitle ?? "";
}
