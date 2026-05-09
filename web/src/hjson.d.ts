declare module "hjson/bundle/hjson.js" {
  const Hjson: {
    parse(text: string, options?: Record<string, unknown>): unknown;
    stringify(value: unknown, options?: Record<string, unknown>): string;
  };
  export default Hjson;
}
