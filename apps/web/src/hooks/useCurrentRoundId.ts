import { useEffect, useState } from "react";
import {
  getCurrentRoundId,
  getSessionId,
  SESSION_UPDATED_EVENT,
} from "../lib/session";

function computeCurrentRoundId(): string | undefined {
  try {
    const roundId = getCurrentRoundId();
    if (!roundId) return undefined;
    const hasSession = !!getSessionId(roundId);
    return hasSession ? roundId : undefined;
  } catch {
    return undefined;
  }
}

export function useCurrentRoundId(): string | undefined {
  const [roundId, setRoundId] = useState<string | undefined>(
    computeCurrentRoundId
  );

  useEffect(() => {
    const updateRoundId = () => {
      setRoundId(computeCurrentRoundId());
    };

    window.addEventListener(SESSION_UPDATED_EVENT, updateRoundId);

    return () => {
      window.removeEventListener(SESSION_UPDATED_EVENT, updateRoundId);
    };
  }, []);

  return roundId;
}
