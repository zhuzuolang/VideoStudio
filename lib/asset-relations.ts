import type { AssetRelation } from "./platform-types";

export const ASSET_RELATION_TYPES = [
  "references",
  "derived_from",
  "component_of",
  "paired_with",
  "belongs_to",
] as const;

export type AssetRelationType = (typeof ASSET_RELATION_TYPES)[number];

export const ASSET_RELATION_META: Record<
  AssetRelationType,
  { label: string; outgoingLabel: string; incomingLabel: string }
> = {
  references: { label: "参考", outgoingLabel: "参考", incomingLabel: "被参考" },
  derived_from: { label: "派生自", outgoingLabel: "派生自", incomingLabel: "派生版本" },
  component_of: { label: "属于/组成", outgoingLabel: "属于", incomingLabel: "包含" },
  paired_with: { label: "配套", outgoingLabel: "配套", incomingLabel: "配套" },
  belongs_to: { label: "归属", outgoingLabel: "归属于", incomingLabel: "拥有" },
};

export function relationDirectionLabel(
  relationType: string,
  direction: AssetRelation["direction"],
): string {
  const meta = ASSET_RELATION_META[relationType as AssetRelationType];
  if (meta) return direction === "incoming" ? meta.incomingLabel : meta.outgoingLabel;
  if (relationType === "related" || !relationType) {
    return direction === "incoming" ? "被关联" : "关联";
  }
  return direction === "incoming" ? `被${relationType}` : relationType;
}

export function relationTypeLabel(relationType: string): string {
  return ASSET_RELATION_META[relationType as AssetRelationType]?.label
    ?? (relationType === "related" || !relationType ? "关联" : relationType);
}
