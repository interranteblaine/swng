import { useEffect } from "react";

export function usePageTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · swng` : "swng";
    return () => {
      document.title = "swng";
    };
  }, [title]);
}
