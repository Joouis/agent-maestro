import { useCallback, useState } from "react";

import { UI_CONFIG } from "../utils/constants";

export const useStatusManager = () => {
  const [statusMessage, setStatusMessage] = useState("");
  const [showStatus, setShowStatus] = useState(false);

  const showStatusMessage = useCallback(
    (message: string, duration = UI_CONFIG.STATUS_DISPLAY_DURATION) => {
      setStatusMessage(message);
      setShowStatus(true);
      setTimeout(() => {
        setShowStatus(false);
      }, duration);
    },
    [],
  );

  const hideStatus = useCallback(() => {
    setShowStatus(false);
  }, []);

  return {
    statusMessage,
    showStatus,
    showStatusMessage,
    hideStatus,
  };
};
