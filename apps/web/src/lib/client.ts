import { createBrowserClient } from "@swng/browser-client";
import { API_BASE_URL, WS_URL } from "../config";

export const client = createBrowserClient({
  baseUrl: API_BASE_URL,
  wsUrl: WS_URL,
});
