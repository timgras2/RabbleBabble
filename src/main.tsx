import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAppServices } from "./app/services";
import { App } from "./App";
import { registerPwa } from "./pwa/register";
import "./index.css";

const services = createAppServices();
registerPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
