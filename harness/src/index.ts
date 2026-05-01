import { moo } from "./moo";
import { dispatch } from "./commands";

(globalThis as any).moo = moo;
(globalThis as any).main = async function main(input: any) {
  return dispatch(input || {});
};
