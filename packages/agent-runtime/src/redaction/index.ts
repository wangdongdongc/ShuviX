/**
 * 自动脱敏的引擎部分（宿主无关）：检测、占位符、已知值。
 * 设计见 docs/auto-redaction-design.md；检测规则移植自 magpie（yetone/magpie v0.1.1548，MIT）。
 */
export {
  SENSITIVE_CATEGORIES,
  CATEGORIES_SENT_BY_DEFAULT,
  isPersonalCategory,
  type SensitiveCategory
} from './categories'
export { detectSensitive, type Finding } from './detect'
export { KnownValues, MIN_KNOWN, type KnownSpan, type KnownValue } from './known'
export {
  PLACEHOLDER_PATTERN,
  categoryOfPlaceholder,
  findPlaceholders,
  makePlaceholder,
  placeholderSpans,
  type PlaceholderHit,
  type PlaceholderSigner
} from './placeholder'
