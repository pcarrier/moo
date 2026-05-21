import "./style.css";
import { render } from "solid-js/web";

import { App } from "./App";
import { captureFragmentPsk } from "./auth";
import { registerServiceWorker } from "./pwa";
import { createState } from "./state";
import { applyStoredThemeMode, startThemeColorSync } from "./theme";

captureFragmentPsk();
applyStoredThemeMode();
startThemeColorSync();
registerServiceWorker();

const mount = document.getElementById("app");
if (!mount) throw new Error("missing #app element");
const root = document.createElement("div");
mount.replaceWith(root);

// Wrap createState in a Solid component so its createSignal/createEffect/
// onCleanup calls have a reactive owner.
function Root() {
  const bag = createState();
  return <App bag={bag} />;
}

render(() => <Root />, root);
