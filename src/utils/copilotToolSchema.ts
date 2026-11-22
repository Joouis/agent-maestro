import * as vscode from "vscode";

import { logger } from "./logger";

const LITERAL_SCHEMA_FIELDS = new Set([
  "default",
  "example",
  "examples",
  "const",
  "enum",
  "required",
  "dependentRequired",
]);

const SCHEMA_MAP_FIELDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);

const BOOLEAN_SCHEMA_KEYWORDS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "contentSchema",
]);

const SCOPE_SENSITIVE_MERGE_KEYWORDS = [
  "$id",
  "id",
  "$ref",
  "$dynamicRef",
  "anyOf",
  "oneOf",
  "prefixItems",
  "additionalProperties",
  "unevaluatedProperties",
  "additionalItems",
  "unevaluatedItems",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependencies",
  "contains",
  "minContains",
  "maxContains",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function primarySchemaType(node: Record<string, unknown>): string | undefined {
  if (typeof node.type === "string") {
    return node.type;
  }
  if (Array.isArray(node.type)) {
    return node.type.find(
      (t): t is string => typeof t === "string" && t !== "null",
    );
  }
  return undefined;
}

function isCompatibleScalarForItemType(
  entry: unknown,
  itemType: string | undefined,
): boolean {
  if (entry === null || typeof entry === "object") {
    return false;
  }
  if (!itemType) {
    return (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    );
  }
  if (itemType === "string") {
    return typeof entry === "string";
  }
  if (itemType === "integer") {
    return typeof entry === "number" && Number.isInteger(entry);
  }
  if (itemType === "number") {
    return typeof entry === "number" && Number.isFinite(entry);
  }
  if (itemType === "boolean") {
    return typeof entry === "boolean";
  }
  return false;
}

function extractTypeList(typeValue: unknown): string[] | undefined {
  if (typeof typeValue === "string") {
    return [typeValue];
  }
  if (Array.isArray(typeValue)) {
    return typeValue.filter((t): t is string => typeof t === "string");
  }
  return undefined;
}

function intersectTypeLists(a: string[], b: string[]): string[] {
  const result: string[] = [];
  for (const t of a) {
    if (b.includes(t)) {
      result.push(t);
    } else if (t === "integer" && b.includes("number")) {
      result.push("integer");
    } else if (t === "number" && b.includes("integer")) {
      result.push("integer");
    }
  }
  return [...new Set(result)];
}

function setOwnField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

const SYNTHETIC_ORIGIN = "https://agent-maestro.local";
const ROOT_BASE_URI = `${SYNTHETIC_ORIGIN}/__root__/schema.json`;

function encodeJsonPointerSegment(segment: string): string {
  const escaped = segment.replace(/~/g, "~0").replace(/\//g, "~1");
  return encodeURI(escaped).replace(/#/g, "%23");
}

function canonicalizeFragment(rawFragment: string): string {
  if (!rawFragment) {
    return "";
  }
  let decodedFragment = rawFragment;
  try {
    decodedFragment = decodeURIComponent(rawFragment);
  } catch {
    // Keep malformed percent-encoding unchanged
  }
  if (decodedFragment.startsWith("/")) {
    return (
      "/" +
      decodedFragment
        .slice(1)
        .split("/")
        .map((seg) => encodeURI(seg).replace(/#/g, "%23").replace(/\//g, "%2F"))
        .join("/")
    );
  }
  return encodeURI(decodedFragment).replace(/#/g, "%23");
}

function hasNewIdScope(node: Record<string, unknown>): string | undefined {
  if (typeof node.$id === "string") {
    const trimmed = node.$id.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed;
    }
  }
  if (typeof node.id === "string") {
    const trimmed = node.id.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveScopeUri(baseUri: string, id: string): string {
  const trimmed = id.trim();
  try {
    const url = new URL(trimmed, baseUri);
    url.hash = "";
    return url.href;
  } catch {
    const withoutHash = trimmed.replace(/#.*$/, "");
    return `${baseUri}/${withoutHash}`;
  }
}

function resolveScopedRef(
  baseUri: string,
  ref: string,
): { targetBaseUri: string; fragment: string; scopedKey: string } {
  const hashIdx = ref.indexOf("#");
  const uriPart = hashIdx >= 0 ? ref.slice(0, hashIdx).trim() : ref.trim();
  const rawFragment = hashIdx >= 0 ? ref.slice(hashIdx + 1) : "";
  const targetBaseUri = uriPart ? resolveScopeUri(baseUri, uriPart) : baseUri;
  const fragment = canonicalizeFragment(rawFragment);
  return {
    targetBaseUri,
    fragment,
    scopedKey: `${targetBaseUri}#${fragment}`,
  };
}

function collectSchemaRefs(
  node: unknown,
  baseUri = ROOT_BASE_URI,
  refs = new Set<string>(),
  externalRefs = new Set<string>(),
): { refs: Set<string>; externalRefs: Set<string> } {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectSchemaRefs(item, baseUri, refs, externalRefs);
    }
    return { refs, externalRefs };
  }
  if (!isPlainRecord(node)) {
    return { refs, externalRefs };
  }
  const newId = hasNewIdScope(node);
  const currentBaseUri = newId ? resolveScopeUri(baseUri, newId) : baseUri;
  for (const refKey of ["$ref", "$dynamicRef"] as const) {
    const rawRef = node[refKey];
    if (typeof rawRef === "string") {
      const resolved = resolveScopedRef(currentBaseUri, rawRef);
      refs.add(resolved.scopedKey);
      if (resolved.targetBaseUri !== currentBaseUri) {
        externalRefs.add(resolved.scopedKey);
      }
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (LITERAL_SCHEMA_FIELDS.has(key)) {
      continue;
    }
    if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(child)) {
      for (const mapEntry of Object.values(child)) {
        if (key === "dependencies" && Array.isArray(mapEntry)) {
          continue;
        }
        collectSchemaRefs(mapEntry, currentBaseUri, refs, externalRefs);
      }
      continue;
    }
    collectSchemaRefs(child, currentBaseUri, refs, externalRefs);
  }
  return { refs, externalRefs };
}

interface ScopeFrame {
  baseUri: string;
  pointer: string;
  trackRefAliases: boolean;
}

interface NormalizationContext {
  allRefs: Set<string>;
  externalRefs: ReadonlySet<string>;
  refRewrites: Map<string, string>;
  visitedNodeCount: number;
  budgetExceeded: boolean;
}

const MAX_NORMALIZED_SCHEMA_NODES = 10_000;

function enterNodeScopeStack(
  scopeStack: ReadonlyArray<ScopeFrame>,
  node: Record<string, unknown>,
  trackRefAliases = true,
): ReadonlyArray<ScopeFrame> {
  if (scopeStack.length === 0) {
    return scopeStack;
  }
  const activeScope = scopeStack[scopeStack.length - 1];
  const newId = hasNewIdScope(node);
  const resolvedUri = newId
    ? resolveScopeUri(activeScope.baseUri, newId)
    : activeScope.baseUri;
  if (resolvedUri === activeScope.baseUri) {
    if (activeScope.trackRefAliases === trackRefAliases) {
      return scopeStack;
    }
    return scopeStack.map((frame) => ({
      ...frame,
      trackRefAliases: frame.trackRefAliases && trackRefAliases,
    }));
  }
  const filtered = scopeStack
    .filter((frame) => frame.baseUri !== resolvedUri)
    .map((frame) => ({
      ...frame,
      trackRefAliases: frame.trackRefAliases && trackRefAliases,
    }));
  return [...filtered, { baseUri: resolvedUri, pointer: "", trackRefAliases }];
}

function appendSegmentToScopeStack(
  scopeStack: ReadonlyArray<ScopeFrame>,
  encodedSegment: string,
  trackRefAliases = true,
): ReadonlyArray<ScopeFrame> {
  return scopeStack.map((frame) => ({
    baseUri: frame.baseUri,
    pointer: `${frame.pointer}/${encodedSegment}`,
    trackRefAliases: frame.trackRefAliases && trackRefAliases,
  }));
}

function hasReferenceToPointer(
  allRefs: ReadonlySet<string>,
  scopedTargetPointer: string,
): boolean {
  for (const ref of allRefs) {
    if (
      ref === scopedTargetPointer ||
      ref.startsWith(`${scopedTargetPointer}/`)
    ) {
      return true;
    }
  }
  return false;
}

function hasReferenceToRelativeSuffix(
  allRefs: ReadonlySet<string>,
  scopeStack: ReadonlyArray<ScopeFrame>,
  relativeSuffix: string,
): boolean {
  if (allRefs.size === 0) {
    return false;
  }
  return scopeStack.some(
    (frame) =>
      frame.trackRefAliases &&
      hasReferenceToPointer(
        allRefs,
        `${frame.baseUri}#${frame.pointer}${relativeSuffix}`,
      ),
  );
}

function hasReferencedResourceInSubtree(
  externalRefs: ReadonlySet<string>,
  baseUri: string,
  node: unknown,
): boolean {
  if (externalRefs.size === 0) {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((item) =>
      hasReferencedResourceInSubtree(externalRefs, baseUri, item),
    );
  }
  if (!isPlainRecord(node)) {
    return false;
  }
  const newId = hasNewIdScope(node);
  const currentBaseUri = newId ? resolveScopeUri(baseUri, newId) : baseUri;
  if (newId) {
    const resourceRootPrefix = `${currentBaseUri}#`;
    for (const ref of externalRefs) {
      if (ref.startsWith(resourceRootPrefix)) {
        return true;
      }
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (LITERAL_SCHEMA_FIELDS.has(key)) {
      continue;
    }
    if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(child)) {
      for (const mapEntry of Object.values(child)) {
        if (key === "dependencies" && Array.isArray(mapEntry)) {
          continue;
        }
        if (
          hasReferencedResourceInSubtree(externalRefs, currentBaseUri, mapEntry)
        ) {
          return true;
        }
      }
      continue;
    }
    if (hasReferencedResourceInSubtree(externalRefs, currentBaseUri, child)) {
      return true;
    }
  }
  return false;
}

function formatRefRelativeToScope(
  enclosingBaseUri: string,
  targetBaseUri: string,
  fragment: string,
): string {
  if (targetBaseUri === enclosingBaseUri) {
    return `#${fragment}`;
  }
  if (!targetBaseUri.startsWith(SYNTHETIC_ORIGIN)) {
    return fragment ? `${targetBaseUri}#${fragment}` : targetBaseUri;
  }
  try {
    const enclosingUrl = new URL(enclosingBaseUri);
    const targetUrl = new URL(targetBaseUri);
    if (
      enclosingUrl.origin === SYNTHETIC_ORIGIN &&
      targetUrl.origin === SYNTHETIC_ORIGIN
    ) {
      const baseSegments = enclosingUrl.pathname.slice(1).split("/");
      baseSegments.pop();
      const targetSegments = targetUrl.pathname.slice(1).split("/");
      const maxCommon = Math.min(
        baseSegments.length,
        Math.max(0, targetSegments.length - 1),
      );
      let commonLen = 0;
      while (
        commonLen < maxCommon &&
        baseSegments[commonLen] === targetSegments[commonLen]
      ) {
        commonLen++;
      }
      const upSegments = Array<string>(baseSegments.length - commonLen).fill(
        "..",
      );
      const relSegments = [...upSegments, ...targetSegments.slice(commonLen)];
      let relPath = relSegments.join("/");
      if (relPath === "") {
        relPath = "./";
      } else if ((relSegments[0] ?? "").includes(":")) {
        relPath = `./${relPath}`;
      }
      const uriPart = `${relPath}${targetUrl.search}`;
      return fragment ? `${uriPart}#${fragment}` : uriPart;
    }
  } catch {
    // Fallback below
  }
  const strippedSynthetic = targetBaseUri.startsWith(ROOT_BASE_URI)
    ? targetBaseUri.slice(ROOT_BASE_URI.length)
    : targetBaseUri;
  return fragment ? `${strippedSynthetic}#${fragment}` : strippedSynthetic;
}

function rebaseStrippedResourceRefs(
  node: unknown,
  enclosingBaseUri: string,
  hoistedPointer: string,
  plannedNewRefs: Set<string>,
  refRewrites?: ReadonlyMap<string, string>,
  relPointer = "",
  currentSourceBaseUri = enclosingBaseUri,
  strippedScopeRoot?: { sourceBaseUri: string; hoistedScopePointer: string },
): unknown {
  if (Array.isArray(node)) {
    return node.map((item, idx) =>
      rebaseStrippedResourceRefs(
        item,
        enclosingBaseUri,
        hoistedPointer,
        plannedNewRefs,
        refRewrites,
        `${relPointer}/${idx}`,
        currentSourceBaseUri,
        strippedScopeRoot,
      ),
    );
  }
  if (!isPlainRecord(node)) {
    return node;
  }
  const newId = hasNewIdScope(node);
  const nextSourceBaseUri = newId
    ? resolveScopeUri(currentSourceBaseUri, newId)
    : currentSourceBaseUri;
  const nextStrippedScopeRoot =
    newId && nextSourceBaseUri !== currentSourceBaseUri
      ? {
          sourceBaseUri: nextSourceBaseUri,
          hoistedScopePointer: `${hoistedPointer}${relPointer}`,
        }
      : strippedScopeRoot;

  const next: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node)) {
    if (
      (key === "$id" || key === "id") &&
      typeof val === "string" &&
      val.trim().length > 0
    ) {
      continue;
    }
    if (key === "$anchor" || key === "$dynamicAnchor") {
      continue;
    }
    if ((key === "$ref" || key === "$dynamicRef") && typeof val === "string") {
      let rebasedRef = val;
      if (nextStrippedScopeRoot) {
        const rewrittenVal =
          refRewrites && refRewrites.size > 0
            ? rewriteRefString(
                val,
                nextStrippedScopeRoot.sourceBaseUri,
                refRewrites,
              )
            : val;
        const resolved = resolveScopedRef(
          nextStrippedScopeRoot.sourceBaseUri,
          rewrittenVal,
        );
        if (resolved.targetBaseUri === nextStrippedScopeRoot.sourceBaseUri) {
          if (resolved.fragment === "" || resolved.fragment.startsWith("/")) {
            const newFragment = `${nextStrippedScopeRoot.hoistedScopePointer}${resolved.fragment}`;
            rebasedRef = `#${newFragment}`;
            plannedNewRefs.add(`${enclosingBaseUri}#${newFragment}`);
          } else {
            rebasedRef = formatRefRelativeToScope(
              enclosingBaseUri,
              nextStrippedScopeRoot.sourceBaseUri,
              resolved.fragment,
            );
          }
        } else if (!rewrittenVal.trim().startsWith("#")) {
          rebasedRef = formatRefRelativeToScope(
            enclosingBaseUri,
            resolved.targetBaseUri,
            resolved.fragment,
          );
        }
      }
      setOwnField(next, key, rebasedRef);
      continue;
    }
    if (LITERAL_SCHEMA_FIELDS.has(key)) {
      setOwnField(next, key, val);
    } else if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(val)) {
      const nextMap: Record<string, unknown> = {};
      const keySeg = encodeJsonPointerSegment(key);
      for (const [propName, propSchema] of Object.entries(val)) {
        if (key === "dependencies" && Array.isArray(propSchema)) {
          setOwnField(nextMap, propName, propSchema);
        } else {
          const propSeg = encodeJsonPointerSegment(propName);
          setOwnField(
            nextMap,
            propName,
            rebaseStrippedResourceRefs(
              propSchema,
              enclosingBaseUri,
              hoistedPointer,
              plannedNewRefs,
              refRewrites,
              `${relPointer}/${keySeg}/${propSeg}`,
              nextSourceBaseUri,
              nextStrippedScopeRoot,
            ),
          );
        }
      }
      setOwnField(next, key, nextMap);
    } else {
      const keySeg = encodeJsonPointerSegment(key);
      setOwnField(
        next,
        key,
        rebaseStrippedResourceRefs(
          val,
          enclosingBaseUri,
          hoistedPointer,
          plannedNewRefs,
          refRewrites,
          `${relPointer}/${keySeg}`,
          nextSourceBaseUri,
          nextStrippedScopeRoot,
        ),
      );
    }
  }
  return next;
}

function extractAnchorNames(
  node: Record<string, unknown>,
  baseUri?: string,
): string[] {
  const anchors: string[] = [];
  for (const anchorKey of ["$anchor", "$dynamicAnchor"] as const) {
    const anchorVal = node[anchorKey];
    if (typeof anchorVal === "string" && anchorVal.trim().length > 0) {
      anchors.push(canonicalizeFragment(anchorVal.trim()));
    }
  }
  for (const idKey of ["$id", "id"] as const) {
    const idVal = node[idKey];
    if (typeof idVal === "string") {
      const trimmed = idVal.trim();
      if (trimmed.startsWith("#") && trimmed.length > 1) {
        anchors.push(canonicalizeFragment(trimmed.slice(1)));
      } else {
        const hashIdx = trimmed.indexOf("#");
        if (hashIdx > 0 && hashIdx < trimmed.length - 1) {
          const fragmentPart = trimmed.slice(hashIdx + 1);
          if (
            !fragmentPart.startsWith("/") &&
            (baseUri === undefined ||
              resolveScopeUri(baseUri, trimmed) === baseUri)
          ) {
            anchors.push(canonicalizeFragment(fragmentPart));
          }
        }
      }
    }
  }
  return anchors;
}

function hasReferencedAnchorInScope(
  allRefs: ReadonlySet<string>,
  baseUri: string,
  node: unknown,
): boolean {
  if (allRefs.size === 0) {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((item) =>
      hasReferencedAnchorInScope(allRefs, baseUri, item),
    );
  }
  if (!isPlainRecord(node)) {
    return false;
  }
  const newId = hasNewIdScope(node);
  if (newId && resolveScopeUri(baseUri, newId) !== baseUri) {
    return false;
  }
  for (const canonicalAnchor of extractAnchorNames(node, baseUri)) {
    if (allRefs.has(`${baseUri}#${canonicalAnchor}`)) {
      return true;
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (LITERAL_SCHEMA_FIELDS.has(key)) {
      continue;
    }
    if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(child)) {
      for (const mapEntry of Object.values(child)) {
        if (key === "dependencies" && Array.isArray(mapEntry)) {
          continue;
        }
        if (hasReferencedAnchorInScope(allRefs, baseUri, mapEntry)) {
          return true;
        }
      }
      continue;
    }
    if (hasReferencedAnchorInScope(allRefs, baseUri, child)) {
      return true;
    }
  }
  return false;
}

function hasAnyIdentifierInSubtree(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => hasAnyIdentifierInSubtree(item));
  }
  if (!isPlainRecord(node)) {
    return false;
  }
  if (hasNewIdScope(node) || extractAnchorNames(node).length > 0) {
    return true;
  }
  for (const [key, child] of Object.entries(node)) {
    if (LITERAL_SCHEMA_FIELDS.has(key)) {
      continue;
    }
    if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(child)) {
      for (const mapEntry of Object.values(child)) {
        if (key === "dependencies" && Array.isArray(mapEntry)) {
          continue;
        }
        if (hasAnyIdentifierInSubtree(mapEntry)) {
          return true;
        }
      }
      continue;
    }
    if (hasAnyIdentifierInSubtree(child)) {
      return true;
    }
  }
  return false;
}

function chargeDuplicatedSubtreeBudget(
  node: unknown,
  extraCopies: number,
  ctx: NormalizationContext,
): void {
  if (extraCopies <= 0 || ctx.budgetExceeded) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      chargeDuplicatedSubtreeBudget(item, extraCopies, ctx);
      if (ctx.budgetExceeded) {
        return;
      }
    }
    return;
  }
  if (!isPlainRecord(node)) {
    return;
  }
  ctx.visitedNodeCount += extraCopies;
  if (ctx.visitedNodeCount > MAX_NORMALIZED_SCHEMA_NODES) {
    ctx.budgetExceeded = true;
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (LITERAL_SCHEMA_FIELDS.has(key)) {
      continue;
    }
    if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(child)) {
      for (const mapEntry of Object.values(child)) {
        if (key === "dependencies" && Array.isArray(mapEntry)) {
          continue;
        }
        chargeDuplicatedSubtreeBudget(mapEntry, extraCopies, ctx);
        if (ctx.budgetExceeded) {
          return;
        }
      }
      continue;
    }
    chargeDuplicatedSubtreeBudget(child, extraCopies, ctx);
    if (ctx.budgetExceeded) {
      return;
    }
  }
}

function hasAnyMultiBranchUnionInSubtree(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => hasAnyMultiBranchUnionInSubtree(item));
  }
  if (!isPlainRecord(node)) {
    return false;
  }
  if (
    (Array.isArray(node.anyOf) && node.anyOf.length > 1) ||
    (Array.isArray(node.oneOf) && node.oneOf.length > 1)
  ) {
    return true;
  }
  for (const [key, child] of Object.entries(node)) {
    if (LITERAL_SCHEMA_FIELDS.has(key)) {
      continue;
    }
    if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(child)) {
      for (const mapEntry of Object.values(child)) {
        if (key === "dependencies" && Array.isArray(mapEntry)) {
          continue;
        }
        if (hasAnyMultiBranchUnionInSubtree(mapEntry)) {
          return true;
        }
      }
      continue;
    }
    if (hasAnyMultiBranchUnionInSubtree(child)) {
      return true;
    }
  }
  return false;
}

function rewriteRefString(
  ref: string,
  baseUri: string,
  refRewrites: ReadonlyMap<string, string>,
): string {
  const resolved = resolveScopedRef(baseUri, ref);
  let currentScoped = resolved.scopedKey;
  const sortedEntries = [...refRewrites.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  let anyRewritten = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [fromPrefix, toPrefix] of sortedEntries) {
      if (currentScoped === fromPrefix) {
        currentScoped = toPrefix;
        changed = true;
        anyRewritten = true;
      } else if (currentScoped.startsWith(`${fromPrefix}/`)) {
        currentScoped = `${toPrefix}${currentScoped.slice(fromPrefix.length)}`;
        changed = true;
        anyRewritten = true;
      }
    }
  }
  if (!anyRewritten) {
    return ref;
  }
  const hashIdx = currentScoped.indexOf("#");
  const newFragment = hashIdx >= 0 ? currentScoped.slice(hashIdx + 1) : "";
  const origHashIdx = ref.indexOf("#");
  const origUriPart = origHashIdx >= 0 ? ref.slice(0, origHashIdx) : ref;
  return `${origUriPart}#${newFragment}`;
}

function applyRefRewrites(
  node: unknown,
  refRewrites: ReadonlyMap<string, string>,
  baseUri = ROOT_BASE_URI,
): unknown {
  if (refRewrites.size === 0) {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => applyRefRewrites(item, refRewrites, baseUri));
  }
  if (!isPlainRecord(node)) {
    return node;
  }
  const newId = hasNewIdScope(node);
  const currentBaseUri = newId ? resolveScopeUri(baseUri, newId) : baseUri;
  const next: Record<string, unknown> = { ...node };
  for (const [key, val] of Object.entries(node)) {
    if ((key === "$ref" || key === "$dynamicRef") && typeof val === "string") {
      setOwnField(
        next,
        key,
        rewriteRefString(val, currentBaseUri, refRewrites),
      );
    } else if (LITERAL_SCHEMA_FIELDS.has(key)) {
      setOwnField(next, key, val);
    } else if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(val)) {
      const nextMap: Record<string, unknown> = { ...val };
      for (const [propName, propSchema] of Object.entries(val)) {
        if (key === "dependencies" && Array.isArray(propSchema)) {
          setOwnField(nextMap, propName, propSchema);
        } else {
          setOwnField(
            nextMap,
            propName,
            applyRefRewrites(propSchema, refRewrites, currentBaseUri),
          );
        }
      }
      setOwnField(next, key, nextMap);
    } else {
      setOwnField(
        next,
        key,
        applyRefRewrites(val, refRewrites, currentBaseUri),
      );
    }
  }
  return next;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function mergePropertyMaps(
  parentMap: Record<string, unknown>,
  branchMap: Record<string, unknown>,
  hasParentAdditionalProps = false,
  parentAdditionalProps?: unknown,
  hasBranchAdditionalProps = false,
  branchAdditionalProps?: unknown,
  parentMapScopeStack: ReadonlyArray<ScopeFrame> = [],
  branchMapScopeStack: ReadonlyArray<ScopeFrame> = [],
  ctx?: NormalizationContext,
  onPropertyRelocated?: (
    pathSegments: ReadonlyArray<string>,
    relocated: Record<string, unknown>,
  ) => void,
  resolveParentKeyScope?: (
    key: string,
    parentVal: unknown,
  ) => ReadonlyArray<ScopeFrame>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...parentMap, ...branchMap };
  for (const [key, parentVal] of Object.entries(parentMap)) {
    const encodedKey = encodeJsonPointerSegment(key);
    const getParentKeyScope = () =>
      resolveParentKeyScope
        ? resolveParentKeyScope(key, parentVal)
        : isPlainRecord(parentVal)
          ? enterNodeScopeStack(
              appendSegmentToScopeStack(parentMapScopeStack, encodedKey),
              parentVal,
            )
          : appendSegmentToScopeStack(parentMapScopeStack, encodedKey);
    if (Object.hasOwn(branchMap, key)) {
      const parentKeyScope = getParentKeyScope();
      const branchVal = branchMap[key];
      const branchKeyScope = isPlainRecord(branchVal)
        ? enterNodeScopeStack(
            appendSegmentToScopeStack(branchMapScopeStack, encodedKey),
            branchVal,
          )
        : appendSegmentToScopeStack(branchMapScopeStack, encodedKey);
      const mergedVal = mergeSchemaNodes(
        parentVal,
        branchVal,
        parentKeyScope,
        branchKeyScope,
        ctx,
        (subPath, relocated) =>
          onPropertyRelocated?.([key, ...subPath], relocated),
      );
      setOwnField(result, key, mergedVal);
      if (ctx?.budgetExceeded) {
        return result;
      }
    } else if (hasBranchAdditionalProps) {
      const parentKeyScope = getParentKeyScope();
      const branchAddScope = isPlainRecord(branchAdditionalProps)
        ? enterNodeScopeStack(branchMapScopeStack, branchAdditionalProps)
        : branchMapScopeStack;
      const mergedVal = mergeSchemaNodes(
        parentVal,
        branchAdditionalProps,
        parentKeyScope,
        branchAddScope,
        ctx,
        (subPath, relocated) =>
          onPropertyRelocated?.([key, ...subPath], relocated),
      );
      setOwnField(result, key, mergedVal);
      if (ctx?.budgetExceeded) {
        return result;
      }
    } else {
      setOwnField(result, key, parentVal);
    }
  }
  for (const [key, branchVal] of Object.entries(branchMap)) {
    if (Object.hasOwn(parentMap, key)) {
      continue;
    }
    if (hasParentAdditionalProps) {
      const encodedKey = encodeJsonPointerSegment(key);
      const parentAddScope = isPlainRecord(parentAdditionalProps)
        ? enterNodeScopeStack(parentMapScopeStack, parentAdditionalProps)
        : parentMapScopeStack;
      const branchKeyScope = isPlainRecord(branchVal)
        ? enterNodeScopeStack(
            appendSegmentToScopeStack(branchMapScopeStack, encodedKey),
            branchVal,
          )
        : appendSegmentToScopeStack(branchMapScopeStack, encodedKey);
      const mergedVal = mergeSchemaNodes(
        parentAdditionalProps,
        branchVal,
        parentAddScope,
        branchKeyScope,
        ctx,
        (subPath, relocated) =>
          onPropertyRelocated?.([key, ...subPath], relocated),
      );
      setOwnField(result, key, mergedVal);
      if (ctx?.budgetExceeded) {
        return result;
      }
    } else {
      setOwnField(result, key, branchVal);
    }
  }
  return result;
}

function mergeSchemaNodes(
  parentNode: unknown,
  branchNode: unknown,
  parentScopeStack: ReadonlyArray<ScopeFrame> = [],
  branchScopeStack: ReadonlyArray<ScopeFrame> = [],
  ctx?: NormalizationContext,
  onRelocated?: (
    pathSegments: ReadonlyArray<string>,
    relocated: Record<string, unknown>,
  ) => void,
): unknown {
  if (parentNode === false || branchNode === false) {
    return false;
  }
  if (parentNode === true) {
    return branchNode;
  }
  if (branchNode === true) {
    return parentNode;
  }
  if (!isPlainRecord(parentNode) || !isPlainRecord(branchNode)) {
    return { allOf: [parentNode, branchNode] };
  }
  if (Object.keys(parentNode).length === 0) {
    return branchNode;
  }
  if (Object.keys(branchNode).length === 0) {
    return parentNode;
  }
  if (stableStringify(parentNode) === stableStringify(branchNode)) {
    return parentNode;
  }
  if (ctx) {
    ctx.visitedNodeCount += 1;
    if (ctx.visitedNodeCount > MAX_NORMALIZED_SCHEMA_NODES) {
      ctx.budgetExceeded = true;
      return parentNode;
    }
  }
  if (
    SCOPE_SENSITIVE_MERGE_KEYWORDS.some(
      (kw) => Object.hasOwn(parentNode, kw) || Object.hasOwn(branchNode, kw),
    ) ||
    typeof parentNode.exclusiveMinimum === "boolean" ||
    typeof branchNode.exclusiveMinimum === "boolean" ||
    typeof parentNode.exclusiveMaximum === "boolean" ||
    typeof branchNode.exclusiveMaximum === "boolean"
  ) {
    return { allOf: [parentNode, branchNode] };
  }

  const merged: Record<string, unknown> = { ...parentNode };
  for (const [key, branchVal] of Object.entries(branchNode)) {
    if (!Object.hasOwn(merged, key)) {
      setOwnField(merged, key, branchVal);
      continue;
    }
    const parentVal = merged[key];
    if (stableStringify(parentVal) === stableStringify(branchVal)) {
      continue;
    }
    if (key === "type") {
      const parentTypes = extractTypeList(parentVal);
      const branchTypes = extractTypeList(branchVal);
      if (parentTypes && branchTypes) {
        const common = intersectTypeLists(parentTypes, branchTypes);
        if (common.length === 0) {
          return false;
        }
        setOwnField(merged, key, common.length === 1 ? common[0] : common);
        continue;
      }
    } else if (
      (key === "properties" || key === "patternProperties") &&
      isPlainRecord(parentVal) &&
      isPlainRecord(branchVal)
    ) {
      const encodedMapKey = encodeJsonPointerSegment(key);
      const parentMapScope = appendSegmentToScopeStack(
        parentScopeStack,
        encodedMapKey,
      );
      const branchMapScope = appendSegmentToScopeStack(
        branchScopeStack,
        encodedMapKey,
      );
      setOwnField(
        merged,
        key,
        mergePropertyMaps(
          parentVal,
          branchVal,
          false,
          undefined,
          false,
          undefined,
          parentMapScope,
          branchMapScope,
          ctx,
          (subPath, relocated) => onRelocated?.([key, ...subPath], relocated),
        ),
      );
      if (ctx?.budgetExceeded) {
        return parentNode;
      }
      continue;
    } else if (
      key === "required" &&
      Array.isArray(parentVal) &&
      Array.isArray(branchVal)
    ) {
      setOwnField(merged, key, [
        ...new Set(
          [...parentVal, ...branchVal].filter(
            (k): k is string => typeof k === "string",
          ),
        ),
      ]);
      continue;
    } else if (
      key === "enum" &&
      Array.isArray(parentVal) &&
      Array.isArray(branchVal)
    ) {
      const allowed = new Set(branchVal.map(stableStringify));
      const commonEnum = parentVal.filter((item) =>
        allowed.has(stableStringify(item)),
      );
      if (commonEnum.length === 0) {
        return false;
      }
      setOwnField(merged, key, commonEnum);
      continue;
    } else if (
      (key === "minLength" ||
        key === "minimum" ||
        key === "exclusiveMinimum" ||
        key === "minItems" ||
        key === "minProperties") &&
      typeof parentVal === "number" &&
      typeof branchVal === "number"
    ) {
      setOwnField(merged, key, Math.max(parentVal, branchVal));
      continue;
    } else if (
      (key === "maxLength" ||
        key === "maximum" ||
        key === "exclusiveMaximum" ||
        key === "maxItems" ||
        key === "maxProperties") &&
      typeof parentVal === "number" &&
      typeof branchVal === "number"
    ) {
      setOwnField(merged, key, Math.min(parentVal, branchVal));
      continue;
    } else if (
      key === "items" &&
      !Array.isArray(parentVal) &&
      !Array.isArray(branchVal)
    ) {
      const parentItemsScope = appendSegmentToScopeStack(
        parentScopeStack,
        "items",
      );
      const branchItemsScope = appendSegmentToScopeStack(
        branchScopeStack,
        "items",
      );
      setOwnField(
        merged,
        key,
        mergeSchemaNodes(
          parentVal,
          branchVal,
          parentItemsScope,
          branchItemsScope,
          ctx,
          (subPath, relocated) =>
            onRelocated?.(["items", ...subPath], relocated),
        ),
      );
      if (ctx?.budgetExceeded) {
        return parentNode;
      }
      continue;
    } else if (key === "description" || key === "title" || key === "default") {
      setOwnField(merged, key, branchVal);
      continue;
    }
    return { allOf: [parentNode, branchNode] };
  }
  const relocated = relocateArrayLevelEnum(
    merged,
    [...parentScopeStack, ...branchScopeStack],
    ctx ? ctx.allRefs : new Set(),
    ctx ? ctx.refRewrites : new Map(),
  );
  if (relocated) {
    onRelocated?.([], relocated);
    return relocated;
  }
  return merged;
}

/**
 * Copilot Gemini accepts `{ anyOf: [...] }` / `{ oneOf: [...] }`, but rejects
 * any schema node that combines `anyOf` / `oneOf` with sibling `type`,
 * `properties`, or `required` keywords on the same object (for example
 * Microsoft 365 WorkIQ MCP `retrieve.parameters.properties.capabilities.items`).
 * Push parent `type` and object constraints down into each compatible branch
 * without flattening the union.
 */
function distributeUnionSiblingKeywords(
  node: Record<string, unknown>,
  scopeStack: ReadonlyArray<ScopeFrame>,
  ctx: NormalizationContext,
): Record<string, unknown> | null {
  const { allRefs, externalRefs, refRewrites } = ctx;
  const unionKey = Array.isArray(node.anyOf)
    ? "anyOf"
    : Array.isArray(node.oneOf)
      ? "oneOf"
      : null;
  if (!unionKey) {
    return null;
  }
  if (
    !Object.hasOwn(node, "type") &&
    !Object.hasOwn(node, "properties") &&
    !Object.hasOwn(node, "required")
  ) {
    return null;
  }

  const activeScope = scopeStack[scopeStack.length - 1];
  const baseUri = activeScope.baseUri;
  const pointer = activeScope.pointer;

  const rawBranches = node[unionKey] as unknown[];
  const parentTypes = extractTypeList(node.type);

  const rawParentProps = isPlainRecord(node.properties)
    ? node.properties
    : undefined;
  const rawParentPatternProps = isPlainRecord(node.patternProperties)
    ? node.patternProperties
    : undefined;
  const parentRequired = Array.isArray(node.required)
    ? node.required.filter((k): k is string => typeof k === "string")
    : [];
  const hasParentAdditionalProps = Object.hasOwn(node, "additionalProperties");
  const hasNonEmptyParentPatternProps = Boolean(
    rawParentPatternProps && Object.keys(rawParentPatternProps).length > 0,
  );

  let nextDefs: Record<string, unknown> | undefined = isPlainRecord(node.$defs)
    ? { ...node.$defs }
    : undefined;
  const pendingPointerRewrites: Array<{
    oldSuffix: string;
    newSuffix: string;
  }> = [];
  const plannedNewRefs = new Set<string>();

  const hasNonEmptyParentProps = Boolean(
    rawParentProps && Object.keys(rawParentProps).length > 0,
  );
  let survivingBranchCount = 0;
  const branchSurvives: boolean[] = [];
  let parentPropsCopyCount = 0;
  let parentPatternPropsCopyCount = 0;
  let parentAdditionalPropsCopyCount = 0;
  const branchDuplicatesIdentifiers = rawBranches.map((rawBranch) => {
    if (rawBranch === false) {
      branchSurvives.push(false);
      return false;
    }
    const branchRecord =
      rawBranch === true
        ? {}
        : isPlainRecord(rawBranch)
          ? rawBranch
          : undefined;
    if (!branchRecord) {
      branchSurvives.push(true);
      survivingBranchCount += 1;
      return false;
    }
    const branchHasDirectRef =
      typeof branchRecord.$ref === "string" ||
      typeof branchRecord.$dynamicRef === "string";
    const branchHasNestedUnion =
      Array.isArray(branchRecord.anyOf) || Array.isArray(branchRecord.oneOf);
    const branchTypes = branchHasDirectRef
      ? undefined
      : extractTypeList(branchRecord.type);
    let effectiveTypes: string[] | undefined;
    if (parentTypes !== undefined) {
      if (branchTypes !== undefined) {
        effectiveTypes = intersectTypeLists(branchTypes, parentTypes);
        if (effectiveTypes.length === 0) {
          branchSurvives.push(false);
          return false;
        }
      } else {
        effectiveTypes = parentTypes;
      }
    } else {
      effectiveTypes = branchTypes;
    }
    branchSurvives.push(true);
    survivingBranchCount += 1;
    const canMatchObject =
      effectiveTypes === undefined || effectiveTypes.includes("object");
    if (!canMatchObject) {
      return false;
    }
    const branchNewId = hasNewIdScope(branchRecord);
    const hasDifferentIdScope = Boolean(
      branchNewId && resolveScopeUri(baseUri, branchNewId) !== baseUri,
    );
    const rawBranchProps = isPlainRecord(branchRecord.properties)
      ? branchRecord.properties
      : undefined;
    const rawBranchPatternProps = isPlainRecord(branchRecord.patternProperties)
      ? branchRecord.patternProperties
      : undefined;
    const hasNonEmptyBranchPatternProps = Boolean(
      rawBranchPatternProps && Object.keys(rawBranchPatternProps).length > 0,
    );
    const hasBranchAdditionalProps = Object.hasOwn(
      branchRecord,
      "additionalProperties",
    );
    const hasBranchUnevaluatedProps = Object.hasOwn(
      branchRecord,
      "unevaluatedProperties",
    );
    if (hasDifferentIdScope || branchHasDirectRef || branchHasNestedUnion) {
      parentPropsCopyCount += 1;
      parentPatternPropsCopyCount += 1;
      parentAdditionalPropsCopyCount += 1;
      return false;
    }
    const isolateParentClosure =
      hasParentAdditionalProps &&
      (hasNonEmptyParentPatternProps || hasNonEmptyBranchPatternProps);
    const isolateBranchClosure =
      hasBranchAdditionalProps &&
      (hasNonEmptyParentPatternProps || hasNonEmptyBranchPatternProps);
    const isolateBranchUnevaluated =
      hasBranchUnevaluatedProps &&
      (hasNonEmptyParentProps ||
        hasNonEmptyParentPatternProps ||
        hasParentAdditionalProps);

    parentPropsCopyCount += isolateParentClosure ? 2 : 1;
    parentPatternPropsCopyCount += isolateParentClosure ? 2 : 1;
    if (isolateParentClosure) {
      parentAdditionalPropsCopyCount += 1;
    } else {
      const branchOnlyPropCount = rawBranchProps
        ? Object.keys(rawBranchProps).filter(
            (k) => !rawParentProps || !Object.hasOwn(rawParentProps, k),
          ).length
        : 0;
      parentAdditionalPropsCopyCount += 1 + branchOnlyPropCount;
    }

    const parentOnlyPropCount = rawParentProps
      ? Object.keys(rawParentProps).filter(
          (k) => !rawBranchProps || !Object.hasOwn(rawBranchProps, k),
        ).length
      : 0;
    return (
      isolateBranchUnevaluated ||
      isolateBranchClosure ||
      (hasBranchAdditionalProps &&
        !isolateBranchClosure &&
        parentOnlyPropCount > 0)
    );
  });

  if (survivingBranchCount === 0) {
    return null;
  }

  const hoistedDefKeysBySuffix = new Map<string, string>();

  const prepareTargetSchema = (
    relativeSuffix: string,
    baseName: string,
    targetSchema: unknown,
    copyCount = 1,
    isDroppedBranch = false,
  ): unknown => {
    const willDuplicateTarget = copyCount > 1;
    if (
      isDroppedBranch &&
      !(
        allRefs.size > 0 &&
        hasReferenceToRelativeSuffix(allRefs, scopeStack, relativeSuffix)
      ) &&
      !(
        allRefs.size > 0 &&
        hasReferencedAnchorInScope(allRefs, baseUri, targetSchema)
      ) &&
      !(
        externalRefs.size > 0 &&
        hasReferencedResourceInSubtree(externalRefs, baseUri, targetSchema)
      )
    ) {
      return targetSchema;
    }
    const targetRelativeSegments = relativeSuffix
      .split("/")
      .filter((s) => s.length > 0);
    let targetScopeStack = scopeStack;
    for (const seg of targetRelativeSegments) {
      targetScopeStack = appendSegmentToScopeStack(targetScopeStack, seg, true);
    }
    const normalizedTarget = normalizeSchemaNode(
      targetSchema,
      true,
      targetScopeStack,
      ctx,
    ).value;
    if (ctx.budgetExceeded) {
      return normalizedTarget;
    }
    const isReferencedByPointer =
      allRefs.size > 0 &&
      hasReferenceToRelativeSuffix(allRefs, scopeStack, relativeSuffix);
    const isReferencedByAnchor =
      allRefs.size > 0 &&
      hasReferencedAnchorInScope(allRefs, baseUri, targetSchema);
    const isReferencedByResource =
      externalRefs.size > 0 &&
      hasReferencedResourceInSubtree(externalRefs, baseUri, targetSchema);
    const isUnionSubschema =
      hasAnyMultiBranchUnionInSubtree(targetSchema) ||
      hasAnyMultiBranchUnionInSubtree(normalizedTarget);
    const hasIdentifiers = hasAnyIdentifierInSubtree(targetSchema);
    const shouldShareViaDefs =
      activeScope.trackRefAliases &&
      !relativeSuffix.startsWith(`/${unionKey}/`) &&
      willDuplicateTarget &&
      isUnionSubschema &&
      !hasIdentifiers;
    const hasDistributedIdentifiers = willDuplicateTarget && hasIdentifiers;
    if (
      !isReferencedByPointer &&
      !isReferencedByAnchor &&
      !isReferencedByResource &&
      !hasDistributedIdentifiers &&
      !shouldShareViaDefs
    ) {
      if (copyCount > 1) {
        chargeDuplicatedSubtreeBudget(normalizedTarget, copyCount - 1, ctx);
      }
      return normalizedTarget;
    }
    if (!nextDefs) {
      nextDefs = {};
    }
    let defKey = baseName;
    let suffix = 1;
    while (Object.hasOwn(nextDefs, defKey)) {
      defKey = `${baseName}_${suffix++}`;
    }
    const newSuffix = `/$defs/${encodeJsonPointerSegment(defKey)}`;
    const hoistedPointer = `${pointer}${newSuffix}`;
    setOwnField(nextDefs, defKey, normalizedTarget);
    hoistedDefKeysBySuffix.set(relativeSuffix, defKey);
    pendingPointerRewrites.push({ oldSuffix: relativeSuffix, newSuffix });
    if (shouldShareViaDefs) {
      plannedNewRefs.add(`${baseUri}#${hoistedPointer}`);
      return { $ref: `#${hoistedPointer}` };
    }
    if (!hasIdentifiers) {
      chargeDuplicatedSubtreeBudget(normalizedTarget, copyCount, ctx);
      return normalizedTarget;
    }
    const rebasedInline = rebaseStrippedResourceRefs(
      targetSchema,
      baseUri,
      hoistedPointer,
      plannedNewRefs,
      refRewrites,
    );
    let inlineScopeStack = scopeStack;
    for (const seg of targetRelativeSegments) {
      inlineScopeStack = appendSegmentToScopeStack(
        inlineScopeStack,
        seg,
        false,
      );
    }
    const inlineNormalized = normalizeSchemaNode(
      rebasedInline,
      true,
      inlineScopeStack,
      ctx,
    ).value;
    if (copyCount > 1) {
      chargeDuplicatedSubtreeBudget(inlineNormalized, copyCount - 1, ctx);
    }
    return inlineNormalized;
  };

  const buildSubpathScopeStack = (
    relativeSuffix: string,
    targetNode?: unknown,
  ): ReadonlyArray<ScopeFrame> => {
    const segments = relativeSuffix.split("/").filter((s) => s.length > 0);
    let resultStack = scopeStack;
    for (const seg of segments) {
      resultStack = appendSegmentToScopeStack(resultStack, seg, true);
    }
    const hoistedKey = hoistedDefKeysBySuffix.get(relativeSuffix);
    if (hoistedKey !== undefined) {
      const encodedDefKey = encodeJsonPointerSegment(hoistedKey);
      const hoistedFrames = scopeStack.map((frame) => ({
        baseUri: frame.baseUri,
        pointer: `${frame.pointer}/$defs/${encodedDefKey}`,
        trackRefAliases: frame.trackRefAliases,
      }));
      resultStack = [...resultStack, ...hoistedFrames];
    }
    if (isPlainRecord(targetNode)) {
      resultStack = enterNodeScopeStack(resultStack, targetNode);
    }
    return resultStack;
  };

  const buildPropertyMapScopeStack = (
    mapKey: "properties" | "patternProperties",
  ): {
    baseStack: ReadonlyArray<ScopeFrame>;
    forProperty: (
      propKey: string,
      propVal: unknown,
    ) => ReadonlyArray<ScopeFrame>;
  } => {
    const baseStack = appendSegmentToScopeStack(scopeStack, mapKey);
    return {
      baseStack,
      forProperty: (propKey: string, propVal: unknown) => {
        const encodedPropKey = encodeJsonPointerSegment(propKey);
        const relativeSuffix = `/${mapKey}/${encodedPropKey}`;
        return buildSubpathScopeStack(relativeSuffix, propVal);
      },
    };
  };

  const syncHoistedMapProperty = (
    mapKey: "properties" | "patternProperties",
    relativePropPath: ReadonlyArray<string>,
    branchIdx: number,
    relocated: Record<string, unknown>,
  ): void => {
    if (!nextDefs || relativePropPath.length === 0) {
      return;
    }
    const topPropKey = relativePropPath[0];
    const encodedTopPropKey = encodeJsonPointerSegment(topPropKey);
    const applyRelocatedAtPath = (
      rootRecord: Record<string, unknown>,
      pathSegments: ReadonlyArray<string>,
    ): Record<string, unknown> | null => {
      if (pathSegments.length === 0) {
        if (!Array.isArray(rootRecord.enum)) {
          return null;
        }
        return relocateArrayLevelEnum(
          {
            ...rootRecord,
            ...(relocated.type !== undefined
              ? {
                  type:
                    relocated.type === "null"
                      ? ["array", "null"]
                      : relocated.type,
                }
              : {}),
            ...(relocated.items !== undefined &&
            !Object.hasOwn(rootRecord, "items")
              ? { items: relocated.items }
              : {}),
          },
          [],
          new Set(),
          new Map(),
        );
      }
      const [head, ...tail] = pathSegments;
      const child = rootRecord[head];
      if (!isPlainRecord(child)) {
        return null;
      }
      const updatedChild = applyRelocatedAtPath(child, tail);
      if (!updatedChild) {
        return null;
      }
      const nextRecord = { ...rootRecord };
      setOwnField(nextRecord, head, updatedChild);
      return nextRecord;
    };

    const parentDefKey = hoistedDefKeysBySuffix.get(
      `/${mapKey}/${encodedTopPropKey}`,
    );
    if (parentDefKey !== undefined && isPlainRecord(nextDefs[parentDefKey])) {
      const updatedParent = applyRelocatedAtPath(
        nextDefs[parentDefKey],
        relativePropPath.slice(1),
      );
      if (updatedParent) {
        setOwnField(nextDefs, parentDefKey, updatedParent);
      }
    }
    const branchDefKey = hoistedDefKeysBySuffix.get(
      `/${unionKey}/${branchIdx}`,
    );
    if (branchDefKey !== undefined && isPlainRecord(nextDefs[branchDefKey])) {
      const updatedBranch = applyRelocatedAtPath(nextDefs[branchDefKey], [
        mapKey,
        ...relativePropPath,
      ]);
      if (updatedBranch) {
        setOwnField(nextDefs, branchDefKey, updatedBranch);
      }
    }
  };

  const preparedBranches = rawBranches.map((rawBranch, branchIdx) => {
    const relativeSuffix = `/${unionKey}/${branchIdx}`;
    return prepareTargetSchema(
      relativeSuffix,
      `${unionKey}_${branchIdx}`,
      rawBranch,
      branchDuplicatesIdentifiers[branchIdx] ? 2 : 1,
      !branchSurvives[branchIdx],
    );
  });
  if (ctx.budgetExceeded) {
    return null;
  }

  let parentProps = rawParentProps;
  if (rawParentProps) {
    const cleanedProps: Record<string, unknown> = {};
    for (const [propKey, propSchema] of Object.entries(rawParentProps)) {
      const encodedPropKey = encodeJsonPointerSegment(propKey);
      const relativeSuffix = `/properties/${encodedPropKey}`;
      const preparedProp = prepareTargetSchema(
        relativeSuffix,
        propKey,
        propSchema,
        parentPropsCopyCount,
      );
      if (ctx.budgetExceeded) {
        return null;
      }
      setOwnField(cleanedProps, propKey, preparedProp);
    }
    parentProps = cleanedProps;
  }

  let parentPatternProps = rawParentPatternProps;
  if (rawParentPatternProps) {
    const cleanedPatternProps: Record<string, unknown> = {};
    for (const [propKey, propSchema] of Object.entries(rawParentPatternProps)) {
      const encodedPropKey = encodeJsonPointerSegment(propKey);
      const relativeSuffix = `/patternProperties/${encodedPropKey}`;
      const preparedPatternProp = prepareTargetSchema(
        relativeSuffix,
        propKey,
        propSchema,
        parentPatternPropsCopyCount,
      );
      if (ctx.budgetExceeded) {
        return null;
      }
      setOwnField(cleanedPatternProps, propKey, preparedPatternProp);
    }
    parentPatternProps = cleanedPatternProps;
  }

  let parentAdditionalProps = node.additionalProperties;
  if (hasParentAdditionalProps) {
    parentAdditionalProps = prepareTargetSchema(
      "/additionalProperties",
      "additionalProperties",
      node.additionalProperties,
      parentAdditionalPropsCopyCount,
    );
    if (ctx.budgetExceeded) {
      return null;
    }
  }

  const parentPropsScope = buildPropertyMapScopeStack("properties");
  const parentPatternPropsScope =
    buildPropertyMapScopeStack("patternProperties");
  const parentAdditionalPropsScopeStack = buildSubpathScopeStack(
    "/additionalProperties",
    parentAdditionalProps,
  );

  const branches: unknown[] = [];
  for (let branchIdx = 0; branchIdx < rawBranches.length; branchIdx++) {
    const rawBranch = rawBranches[branchIdx];
    if (rawBranch === false) {
      continue;
    }
    const branchRecord =
      rawBranch === true
        ? {}
        : isPlainRecord(rawBranch)
          ? rawBranch
          : undefined;
    if (!branchRecord) {
      branches.push(rawBranch);
      continue;
    }

    const branchHasDirectRef =
      typeof branchRecord.$ref === "string" ||
      typeof branchRecord.$dynamicRef === "string";
    const branchTypes = branchHasDirectRef
      ? undefined
      : extractTypeList(branchRecord.type);
    let effectiveTypes: string[] | undefined;
    if (parentTypes !== undefined) {
      if (branchTypes !== undefined) {
        effectiveTypes = intersectTypeLists(branchTypes, parentTypes);
        if (effectiveTypes.length === 0) {
          continue;
        }
      } else {
        effectiveTypes = parentTypes;
      }
    } else {
      effectiveTypes = branchTypes;
    }

    const branchNewId = hasNewIdScope(branchRecord);
    const hasDifferentIdScope = Boolean(
      branchNewId && resolveScopeUri(baseUri, branchNewId) !== baseUri,
    );

    const preparedBranch = preparedBranches[branchIdx];
    const inlineBranchRecord = (
      isPlainRecord(preparedBranch) ? preparedBranch : branchRecord
    ) as Record<string, unknown>;

    const inlineHasNestedUnion =
      Array.isArray(inlineBranchRecord.anyOf) ||
      Array.isArray(inlineBranchRecord.oneOf);
    if (hasDifferentIdScope || branchHasDirectRef || inlineHasNestedUnion) {
      const canMatchObject =
        effectiveTypes === undefined || effectiveTypes.includes("object");
      const wrappedBranch: Record<string, unknown> = {
        ...(effectiveTypes !== undefined
          ? {
              type:
                effectiveTypes.length === 1
                  ? effectiveTypes[0]
                  : effectiveTypes,
            }
          : {}),
        ...(canMatchObject && parentProps ? { properties: parentProps } : {}),
        ...(canMatchObject && parentPatternProps
          ? { patternProperties: parentPatternProps }
          : {}),
        ...(canMatchObject && parentRequired.length > 0
          ? { required: parentRequired }
          : {}),
        ...(canMatchObject && hasParentAdditionalProps
          ? { additionalProperties: parentAdditionalProps }
          : {}),
        allOf: [inlineBranchRecord],
      };
      branches.push(wrappedBranch);
      continue;
    }

    ctx.visitedNodeCount += 1;
    if (ctx.visitedNodeCount > MAX_NORMALIZED_SCHEMA_NODES) {
      ctx.budgetExceeded = true;
      return null;
    }

    const branch = inlineBranchRecord;
    const branchRelativeSuffix = `/${unionKey}/${branchIdx}`;
    const branchScopeStack = buildSubpathScopeStack(
      branchRelativeSuffix,
      branch,
    );

    let mergedBranch: Record<string, unknown> = { ...branch };
    if (effectiveTypes !== undefined) {
      mergedBranch.type =
        effectiveTypes.length === 1 ? effectiveTypes[0] : effectiveTypes;
    }

    const canMatchObject =
      effectiveTypes === undefined || effectiveTypes.includes("object");
    if (canMatchObject) {
      const branchProps = isPlainRecord(branch.properties)
        ? branch.properties
        : undefined;
      const branchPatternProps = isPlainRecord(branch.patternProperties)
        ? branch.patternProperties
        : undefined;
      const hasNonEmptyBranchPatternProps = Boolean(
        branchPatternProps && Object.keys(branchPatternProps).length > 0,
      );
      const hasBranchAdditionalProps = Object.hasOwn(
        branch,
        "additionalProperties",
      );
      const hasBranchUnevaluatedProps = Object.hasOwn(
        branch,
        "unevaluatedProperties",
      );
      const hasNonEmptyParentProps = Boolean(
        parentProps && Object.keys(parentProps).length > 0,
      );

      const isolateParentClosure =
        hasParentAdditionalProps &&
        (hasNonEmptyParentPatternProps || hasNonEmptyBranchPatternProps);
      const isolateBranchClosure =
        hasBranchAdditionalProps &&
        (hasNonEmptyParentPatternProps || hasNonEmptyBranchPatternProps);
      const isolateBranchUnevaluated =
        hasBranchUnevaluatedProps &&
        (hasNonEmptyParentProps ||
          hasNonEmptyParentPatternProps ||
          hasParentAdditionalProps);

      if (
        hasNonEmptyParentProps ||
        (branchProps && hasParentAdditionalProps && !isolateParentClosure)
      ) {
        const branchPropsScopeStack = appendSegmentToScopeStack(
          branchScopeStack,
          "properties",
        );
        mergedBranch.properties = mergePropertyMaps(
          parentProps ?? {},
          branchProps ?? {},
          hasParentAdditionalProps && !isolateParentClosure,
          parentAdditionalProps,
          hasBranchAdditionalProps && !isolateBranchClosure,
          branch.additionalProperties,
          parentPropsScope.baseStack,
          branchPropsScopeStack,
          ctx,
          (propPath, relocated) =>
            syncHoistedMapProperty(
              "properties",
              propPath,
              branchIdx,
              relocated,
            ),
          parentPropsScope.forProperty,
        );
        if (ctx.budgetExceeded) {
          return null;
        }
      }
      if (hasNonEmptyParentPatternProps) {
        const branchPatternPropsScopeStack = appendSegmentToScopeStack(
          branchScopeStack,
          "patternProperties",
        );
        mergedBranch.patternProperties = branchPatternProps
          ? mergePropertyMaps(
              parentPatternProps!,
              branchPatternProps,
              false,
              undefined,
              false,
              undefined,
              parentPatternPropsScope.baseStack,
              branchPatternPropsScopeStack,
              ctx,
              (propPath, relocated) =>
                syncHoistedMapProperty(
                  "patternProperties",
                  propPath,
                  branchIdx,
                  relocated,
                ),
              parentPatternPropsScope.forProperty,
            )
          : { ...parentPatternProps };
        if (ctx.budgetExceeded) {
          return null;
        }
      }
      if (parentRequired.length > 0) {
        const branchReq = Array.isArray(branch.required)
          ? branch.required.filter((k): k is string => typeof k === "string")
          : [];
        mergedBranch.required = [...new Set([...parentRequired, ...branchReq])];
      }

      const closureConjuncts: Record<string, unknown>[] = [];
      if (isolateParentClosure) {
        closureConjuncts.push({
          ...(parentProps ? { properties: parentProps } : {}),
          ...(parentPatternProps
            ? { patternProperties: parentPatternProps }
            : {}),
          additionalProperties: parentAdditionalProps,
        });
      }
      if (isolateBranchClosure) {
        if (!isolateBranchUnevaluated) {
          closureConjuncts.push({
            ...(branchProps ? { properties: branchProps } : {}),
            ...(branchPatternProps
              ? { patternProperties: branchPatternProps }
              : {}),
            additionalProperties: branch.additionalProperties,
          });
        }
        if (!hasParentAdditionalProps || isolateParentClosure) {
          delete mergedBranch.additionalProperties;
        }
      }
      if (isolateBranchUnevaluated) {
        closureConjuncts.push({ ...branch });
        delete mergedBranch.unevaluatedProperties;
      }
      if (hasParentAdditionalProps && !isolateParentClosure) {
        const branchAddScope = appendSegmentToScopeStack(
          branchScopeStack,
          "additionalProperties",
        );
        mergedBranch.additionalProperties =
          hasBranchAdditionalProps && !isolateBranchClosure
            ? mergeSchemaNodes(
                parentAdditionalProps,
                branch.additionalProperties,
                parentAdditionalPropsScopeStack,
                branchAddScope,
                ctx,
              )
            : parentAdditionalProps;
        if (ctx.budgetExceeded) {
          return null;
        }
      }
      if (closureConjuncts.length > 0) {
        const existingAllOf = Array.isArray(mergedBranch.allOf)
          ? mergedBranch.allOf
          : [];
        mergedBranch.allOf = [...existingAllOf, ...closureConjuncts];
      }
    }

    const branchTypeBeforeRelocate = mergedBranch.type;
    const relocatedBranch = relocateArrayLevelEnum(
      mergedBranch,
      branchScopeStack,
      allRefs,
      refRewrites,
      isPlainRecord(node.items) ? node.items : undefined,
    );
    if (relocatedBranch) {
      mergedBranch = relocatedBranch;
      const branchDefKey = hoistedDefKeysBySuffix.get(branchRelativeSuffix);
      if (
        nextDefs &&
        branchDefKey !== undefined &&
        isPlainRecord(nextDefs[branchDefKey]) &&
        Array.isArray(nextDefs[branchDefKey].enum)
      ) {
        const hoistedBranch = nextDefs[branchDefKey];
        const updatedHoistedBranch = relocateArrayLevelEnum(
          {
            ...hoistedBranch,
            ...(branchTypeBeforeRelocate !== undefined
              ? { type: branchTypeBeforeRelocate }
              : {}),
          },
          [],
          new Set(),
          new Map(),
          isPlainRecord(node.items) ? node.items : undefined,
        );
        if (updatedHoistedBranch) {
          setOwnField(nextDefs, branchDefKey, updatedHoistedBranch);
        }
      }
    }

    branches.push(mergedBranch);
  }

  if (branches.length === 0) {
    return null;
  }

  for (const newRef of plannedNewRefs) {
    allRefs.add(newRef);
  }
  for (const { oldSuffix, newSuffix } of pendingPointerRewrites) {
    for (const frame of scopeStack) {
      if (!frame.trackRefAliases) {
        continue;
      }
      const scopedTargetPointer = `${frame.baseUri}#${frame.pointer}${oldSuffix}`;
      if (hasReferenceToPointer(allRefs, scopedTargetPointer)) {
        const scopedNewPointer = `${frame.baseUri}#${frame.pointer}${newSuffix}`;
        refRewrites.set(scopedTargetPointer, scopedNewPointer);
        for (const existingRef of [...allRefs]) {
          if (existingRef === scopedTargetPointer) {
            allRefs.delete(existingRef);
            allRefs.add(scopedNewPointer);
          } else if (existingRef.startsWith(`${scopedTargetPointer}/`)) {
            allRefs.delete(existingRef);
            allRefs.add(
              `${scopedNewPointer}${existingRef.slice(scopedTargetPointer.length)}`,
            );
          }
        }
      }
    }
  }

  const {
    type: _t,
    properties: _p,
    required: _r,
    patternProperties: _pp,
    additionalProperties: _ap,
    ...rest
  } = node;
  if (nextDefs) {
    setOwnField(rest, "$defs", nextDefs);
  }
  return {
    ...rest,
    [unionKey]: branches,
  };
}

/**
 * Copilot Gemini rejects `enum` declared on `type: "array"` (for example IcM
 * MCP `search_incidents.parameters.properties.severity`). Move compatible
 * scalar enum choices onto `items.enum`, or strip unsupported non-scalar array
 * enums.
 */
function relocateArrayLevelEnum(
  node: Record<string, unknown>,
  scopeStack: ReadonlyArray<ScopeFrame>,
  allRefs: Set<string>,
  refRewrites: Map<string, string>,
  fallbackParentItems?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!Array.isArray(node.enum) || primarySchemaType(node) !== "array") {
    return null;
  }

  const nonNullEnum = node.enum.filter((entry) => entry !== null);
  const { enum: _enumValues, ...rest } = node;
  if (
    nonNullEnum.length === 0 &&
    node.enum.includes(null) &&
    extractTypeList(node.type)?.includes("null")
  ) {
    const { items: _items, ...nullRest } = rest;
    return {
      ...nullRest,
      type: "null",
    };
  }
  const ownItems = isPlainRecord(node.items) ? node.items : undefined;
  const ownItemTypes = ownItems ? extractTypeList(ownItems.type) : undefined;
  const parentItemTypes = fallbackParentItems
    ? extractTypeList(fallbackParentItems.type)
    : undefined;
  let effectiveItemTypes: string[] | undefined;
  if (ownItemTypes !== undefined && parentItemTypes !== undefined) {
    effectiveItemTypes = intersectTypeLists(ownItemTypes, parentItemTypes);
  } else {
    effectiveItemTypes = ownItemTypes ?? parentItemTypes;
  }
  const hasIncompatibleItemTypes =
    effectiveItemTypes !== undefined && effectiveItemTypes.length === 0;
  const itemType =
    effectiveItemTypes && effectiveItemTypes.length === 1
      ? effectiveItemTypes[0]
      : undefined;
  const isCompatibleScalarEnum =
    !hasIncompatibleItemTypes &&
    (effectiveItemTypes === undefined || effectiveItemTypes.length === 1) &&
    nonNullEnum.length > 0 &&
    nonNullEnum.every((entry) =>
      isCompatibleScalarForItemType(entry, itemType),
    );
  const canRelocateToItems = ownItems
    ? !Array.isArray(ownItems.enum)
    : !Object.hasOwn(node, "items") &&
      (!fallbackParentItems || !Array.isArray(fallbackParentItems.enum));

  if (isCompatibleScalarEnum && canRelocateToItems) {
    if (allRefs.size > 0) {
      for (const frame of scopeStack) {
        if (!frame.trackRefAliases) {
          continue;
        }
        const enumPointer = `${frame.baseUri}#${frame.pointer}/enum`;
        const newEnumPointer = `${frame.baseUri}#${frame.pointer}/items/enum`;
        if (hasReferenceToPointer(allRefs, enumPointer)) {
          refRewrites.set(enumPointer, newEnumPointer);
          for (const existingRef of [...allRefs]) {
            if (existingRef === enumPointer) {
              allRefs.delete(existingRef);
              allRefs.add(newEnumPointer);
            } else if (existingRef.startsWith(`${enumPointer}/`)) {
              allRefs.delete(existingRef);
              allRefs.add(
                `${newEnumPointer}${existingRef.slice(enumPointer.length)}`,
              );
            }
          }
        }
      }
    }
    return {
      ...rest,
      items: {
        ...(ownItems ?? {}),
        enum: nonNullEnum,
      },
    };
  }
  return rest;
}

function normalizeSchemaNode(
  value: unknown,
  inSchemaPosition = false,
  scopeStack: ReadonlyArray<ScopeFrame> = [
    { baseUri: ROOT_BASE_URI, pointer: "", trackRefAliases: true },
  ],
  ctx: NormalizationContext = {
    allRefs: new Set(),
    externalRefs: new Set(),
    refRewrites: new Map(),
    visitedNodeCount: 0,
    budgetExceeded: false,
  },
): { value: unknown; changed: boolean } {
  if (ctx.budgetExceeded) {
    return { value, changed: false };
  }
  ctx.visitedNodeCount += 1;
  if (ctx.visitedNodeCount > MAX_NORMALIZED_SCHEMA_NODES) {
    ctx.budgetExceeded = true;
    return { value, changed: false };
  }
  if (value === true && inSchemaPosition) {
    return { value: {}, changed: true };
  }
  if (Array.isArray(value)) {
    let anyChanged = false;
    const mapped = value.map((item, index) => {
      const res = normalizeSchemaNode(
        item,
        inSchemaPosition,
        appendSegmentToScopeStack(scopeStack, String(index)),
        ctx,
      );
      if (res.changed) {
        anyChanged = true;
      }
      return res.value;
    });
    return anyChanged && !ctx.budgetExceeded
      ? { value: mapped, changed: true }
      : { value, changed: false };
  }
  if (!isPlainRecord(value)) {
    return { value, changed: false };
  }

  const currentScopeStack = enterNodeScopeStack(scopeStack, value);

  let current: Record<string, unknown> = value;
  let nodeChanged = false;

  const relocated = relocateArrayLevelEnum(
    current,
    currentScopeStack,
    ctx.allRefs,
    ctx.refRewrites,
  );
  if (relocated) {
    current = relocated;
    nodeChanged = true;
  }

  const preHoistedDefKeys =
    isPlainRecord(current.$defs) &&
    (Array.isArray(current.anyOf) || Array.isArray(current.oneOf))
      ? new Set(Object.keys(current.$defs))
      : undefined;
  const unionKeyBeforeDistribute = Array.isArray(current.anyOf)
    ? "anyOf"
    : Array.isArray(current.oneOf)
      ? "oneOf"
      : undefined;

  const distributed = distributeUnionSiblingKeywords(
    current,
    currentScopeStack,
    ctx,
  );
  if (ctx.budgetExceeded) {
    return { value, changed: false };
  }
  const newlyHoistedDefKeys = new Set<string>();
  if (distributed) {
    if (isPlainRecord(distributed.$defs)) {
      for (const defKey of Object.keys(distributed.$defs)) {
        if (!preHoistedDefKeys || !preHoistedDefKeys.has(defKey)) {
          newlyHoistedDefKeys.add(defKey);
        }
      }
    }
    current = distributed;
    nodeChanged = true;
  }

  let childChanged = false;
  const nextRecord: Record<string, unknown> = { ...current };
  for (const [key, item] of Object.entries(current)) {
    if (LITERAL_SCHEMA_FIELDS.has(key)) {
      setOwnField(nextRecord, key, item);
      continue;
    }
    const isDistributedUnionKey =
      distributed !== null && key === unionKeyBeforeDistribute;
    if (isDistributedUnionKey) {
      setOwnField(nextRecord, key, item);
      continue;
    }
    const keyScopeStack = appendSegmentToScopeStack(
      currentScopeStack,
      encodeJsonPointerSegment(key),
    );
    if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(item)) {
      let mapChanged = false;
      const nextMap: Record<string, unknown> = { ...item };
      for (const [propName, propSchema] of Object.entries(item)) {
        if (key === "dependencies" && Array.isArray(propSchema)) {
          setOwnField(nextMap, propName, propSchema);
          continue;
        }
        if (key === "$defs" && newlyHoistedDefKeys.has(propName)) {
          setOwnField(nextMap, propName, propSchema);
          continue;
        }
        const propScopeStack = appendSegmentToScopeStack(
          keyScopeStack,
          encodeJsonPointerSegment(propName),
        );
        const res = normalizeSchemaNode(propSchema, true, propScopeStack, ctx);
        if (ctx.budgetExceeded) {
          return { value, changed: false };
        }
        if (res.changed) {
          mapChanged = true;
        }
        setOwnField(nextMap, propName, res.value);
      }
      if (mapChanged) {
        childChanged = true;
        setOwnField(nextRecord, key, nextMap);
      } else {
        setOwnField(nextRecord, key, item);
      }
      continue;
    }
    const res = normalizeSchemaNode(
      item,
      BOOLEAN_SCHEMA_KEYWORDS.has(key) ||
        key === "prefixItems" ||
        key === "anyOf" ||
        key === "oneOf" ||
        key === "allOf",
      keyScopeStack,
      ctx,
    );
    if (ctx.budgetExceeded) {
      return { value, changed: false };
    }
    if (res.changed) {
      childChanged = true;
    }
    setOwnField(nextRecord, key, res.value);
  }

  if (!nodeChanged && !childChanged) {
    return { value, changed: false };
  }
  return { value: nextRecord, changed: true };
}

function normalizeRootSchema(value: unknown): {
  value: unknown;
  changed: boolean;
} {
  const { refs: allRefs, externalRefs } = collectSchemaRefs(value);
  const ctx: NormalizationContext = {
    allRefs,
    externalRefs,
    refRewrites: new Map<string, string>(),
    visitedNodeCount: 0,
    budgetExceeded: false,
  };
  const res = normalizeSchemaNode(
    value,
    false,
    [{ baseUri: ROOT_BASE_URI, pointer: "", trackRefAliases: true }],
    ctx,
  );
  if (ctx.budgetExceeded || !res.changed) {
    return { value, changed: false };
  }
  if (ctx.refRewrites.size > 0) {
    return {
      value: applyRefRewrites(res.value, ctx.refRewrites, ROOT_BASE_URI),
      changed: true,
    };
  }
  return res;
}

/**
 * Normalize MCP tool parameter schemas for Copilot Gemini models, rewriting
 * only constructs that Copilot Gemini rejects with HTTP 400
 * `invalid_request_body`:
 *  1. Array-level `enum` -> `items.enum` (e.g. IcM MCP `search_incidents`).
 *  2. `anyOf` / `oneOf` nodes that also declare sibling `type`, `properties`,
 *     or `required` on the same node (e.g. WorkIQ MCP `retrieve`).
 *  3. Boolean property schemas (`true` -> `{}`, e.g. ETW MCP `add_condition`).
 */
export function normalizeCopilotToolSchema(value: unknown): unknown {
  return normalizeRootSchema(value).value;
}

export function normalizeToolsForCopilotModel(
  client: vscode.LanguageModelChat,
  tools: vscode.LanguageModelChatTool[] | undefined,
  supportedVendor: string,
): vscode.LanguageModelChatTool[] | undefined {
  const isCopilotGemini =
    client.vendor === supportedVendor &&
    (client.family.toLowerCase().includes("gemini") ||
      client.id.toLowerCase().includes("gemini"));
  if (!isCopilotGemini || !Array.isArray(tools) || tools.length === 0) {
    return tools;
  }

  const rewrittenToolNames: string[] = [];
  const nextTools = tools.map((tool) => {
    if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
      return tool;
    }
    const { value, changed } = normalizeRootSchema(tool.inputSchema);
    if (!changed) {
      return tool;
    }
    rewrittenToolNames.push(tool.name);
    return {
      ...tool,
      inputSchema: value as object,
    };
  });

  if (rewrittenToolNames.length === 0) {
    return tools;
  }

  logger.debug(
    `Normalized Copilot Gemini tool schema(s) for ${client.id}: ${rewrittenToolNames.join(", ")}`,
  );
  return nextTools;
}
