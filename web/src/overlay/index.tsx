import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/app.css";
import "./overlay.css";
import { initI18n } from "@/i18n";
import { OverlayApp } from "./OverlayApp";

const rootEl = document.getElementById("root");
if (rootEl) {
  // Resolve the UI language before the first render so no wrong-language
  // frame is ever shown.
  void initI18n().finally(() => {
    createRoot(rootEl).render(
      <StrictMode>
        <OverlayApp />
      </StrictMode>,
    );
  });
}
