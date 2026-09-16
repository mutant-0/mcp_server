/**
 * Browser entry for the DNA import Apps SDK component.
 *
 * Kept separate from `app.tsx` so the component itself can be rendered by tests
 * without this module's mount side effect: this file only attaches the app to the
 * document the host serves.
 */
import { createRoot } from "react-dom/client";
import { DnaImportApp } from "./app";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<DnaImportApp />);
}
