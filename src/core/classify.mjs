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

const ASCII_ONLY = /^[\x20-\x7e]+$/;
const _keywordPatterns = new Map();

function matchesKeyword(haystack, keyword) {
  const k = keyword.toLowerCase();
  if (!ASCII_ONLY.test(k)) return haystack.includes(k);
  let re = _keywordPatterns.get(k);
  if (!re) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // allow a plural form so "photos" still matches the keyword "photo"
    re = new RegExp(`(^|[^a-z0-9])${escaped}(e?s)?([^a-z0-9]|$)`);
    _keywordPatterns.set(k, re);
  }
  return re.test(haystack);
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
    // Matched against the directory name only. A word like "skill" is useless
    // in a description (nearly every Skill mentions it) but precise in a name.
    if (cat.nameContains && cat.nameContains.some((c) => nameLower.includes(c.toLowerCase()))) {
      return cat.name;
    }
  }

  // 3. Keyword match. ASCII keywords need a word boundary so "test" does not
  //    match "latest" and "git" does not match "digit"; CJK has no word
  //    boundaries, so those match as plain substrings.
  const haystack = `${nameLower} ${descLower}`;
  for (const cat of categories) {
    if (cat.keywords && cat.keywords.some((k) => matchesKeyword(haystack, k))) {
      return cat.name;
    }
  }

  // 4. Fallback
  return "其他 / 未分类";
}
