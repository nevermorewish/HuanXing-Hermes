import { BRAND } from "@/lib/brand.generated";

function modelMatchKeys(model: string): string[] {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return [];
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? [normalized, normalized.slice(slash + 1)] : [normalized];
}

export function accountModelDescription(model: string): string | undefined {
  const descriptions = BRAND.accountModelDescriptions ?? {};
  for (const key of modelMatchKeys(model)) {
    const description = descriptions[key];
    if (typeof description === "string" && description.trim()) {
      return description.trim();
    }
  }
  return undefined;
}
