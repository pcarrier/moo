import "./style.css";
import { render } from "solid-js/web";

import { App } from "./App";
import { captureFragmentPsk } from "./auth";
import { createState } from "./state";
import { applyStoredThemeMode } from "./theme";

captureFragmentPsk();
applyStoredThemeMode();

const mount = document.getElementById("app");
if (!mount) throw new Error("missing #app element");
mount.remove();

// Wrap createState in a Solid component so its createSignal/createEffect/
// onCleanup calls have a reactive owner.
function Root() {
  const bag = createState();
  return <App bag={bag} />;
}

render(() => <Root />, document.body);
