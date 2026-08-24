import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RULES_DIR } from "./paths.mjs";

let _categoriesConfigCache = null;

export function loadCategoriesConfig() {
  if (_categoriesConfigCache) return _categoriesConfigCache;
  const file = join(RULES_DIR, "categories.json");
  if (existsSync(file)) {
    try {
      _categoriesConfigCache = JSON.parse(readFileSync(file, "utf-8"));
      return _categoriesConfigCache;
    } catch {}
  }
  return [];
}

export function classifySkill(skillName, description = "", categoryOverrides = {}) {
  // 1. Manual user override (highest priority)
  if (categoryOverrides && categoryOverrides[skillName]) {
    return categoryOverrides[skillName];
  }

  const categories = loadCategoriesConfig();
  const nameLower = skillName.toLowerCase();
  const descLower = (description || "").toLowerCase();

  // 2. Rule matching
  for (const cat of categories) {
    if (cat.exact && cat.exact.some((e) => e.toLowerCase() === nameLower)) {
      return cat.name;
    }
    if (cat.prefix && cat.prefix.some((p) => nameLower.startsWith(p.toLowerCase()))) {
      return cat.name;
    }
    if (cat.suffix && cat.suffix.some((s) => nameLower.endsWith(s.toLowerCase()))) {
      return cat.name;
    }
    if (cat.contains && cat.contains.some((c) => nameLower.includes(c.toLowerCase()))) {
      return cat.name;
    }
  }

  // 3. Keyword semantic fallback
  for (const cat of categories) {
    if (cat.keywords && cat.keywords.some((k) => nameLower.includes(k.toLowerCase()) || descLower.includes(k.toLowerCase()))) {
      return cat.name;
    }
  }

  // 4. Fallback
  return "其他 / 未分类";
}
