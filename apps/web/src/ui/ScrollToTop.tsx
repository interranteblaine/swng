import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router";

// PUSH/REPLACE start a new page at the top; POP (back/forward) is left to the browser.
// react-router's own <ScrollRestoration> needs a data router — deliberately deferred (spec §8).
export function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    if (navigationType !== "POP") window.scrollTo(0, 0);
  }, [pathname, navigationType]);
  return null;
}
