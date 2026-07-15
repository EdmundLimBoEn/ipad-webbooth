export type Fit = "cover" | "contain";

export type Slot = { x: number; y: number; w: number; h: number; fit?: Fit };

export type FrameDefinition = {
  label: string;
  shots: number;
  intervalMs: number;
  canvas: { w: number; h: number };
  fit?: Fit;
  background?: string;
  bgImage?: string;
  overlay?: string;
  preview?: string;
  slots: Slot[];
};

export type FramePackManifest = {
  version: 1;
  pack: { key: string; label: string };
  templates: Record<string, FrameDefinition>;
};

export type Template = Omit<FrameDefinition, "preview"> & {
  group?: string;
};

export type AssetInfo = { path: string; width: number; height: number };

export type ValidationIssue = {
  path: string;
  message: string;
};
