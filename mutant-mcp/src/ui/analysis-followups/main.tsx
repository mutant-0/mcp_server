/**
 * Browser entry for the analysis follow-up Apps SDK component.
 *
 * Kept separate from `app.tsx` so the component can be rendered by tests without
 * this module's mount side effect: this file only attaches the app to the
 * document the host serves.
 */
import { createRoot } from "react-dom/client";
import { AnalysisFollowupsApp } from "./app";

const container = document.getElementById("root");
if (container) {
  // Defensive: the document stylesheet already sizes `#root`, but the host can
  // wrap or restyle the mount node, so pin full-width here too.
  container.style.width = "100%";
  container.style.maxWidth = "none";
  container.style.minWidth = "0";
  createRoot(container).render(<AnalysisFollowupsApp />);
}
