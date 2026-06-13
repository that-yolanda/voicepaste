import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsApp } from "./SettingsApp";
import "../styles/app.css";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <SettingsApp />
    </StrictMode>,
  );
}
