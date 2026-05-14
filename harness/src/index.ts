import { moo } from "./moo";
import { dispatch } from "./commands";
import type { Input } from "./commands/_shared";

type HarnessGlobal = typeof globalThis & {
  moo: typeof moo;
  main: (input?: Input | null) => ReturnType<typeof dispatch>;
};

const harnessGlobal = globalThis as HarnessGlobal;
harnessGlobal.moo = moo;
harnessGlobal.main = async function main(input: Input | null = null) {
  return dispatch(input || {});
};
