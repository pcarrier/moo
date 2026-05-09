export type UiAppApiMethod = { name: string; input?: unknown };

export type UiAppManifest = {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  entry?: string;
  api?: UiAppApiMethod[];
};

export type UiAppBundle = {
  html?: string;
  css?: string;
  js?: string;
  files?: Record<string, string>;
};
