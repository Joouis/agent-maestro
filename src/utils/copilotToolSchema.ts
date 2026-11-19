import * as vscode from "vscode";

const LITERAL_SCHEMA_FIELDS = new Set([
  "default",
  "example",
  "examples",
  "const",
  "enum",
  "required",
]);

const SCHEMA_MAP_FIELDS = new Set(["properties", "patternProperties"]);

const STRIPPED_SCHEMA_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "additionalProperties",
]);

const MAX_SCHEMA_REF_EXPANSIONS = 256;

const SCALAR_BOUND_MIN_KEYS = [
  "minimum",
  "exclusiveMinimum",
  "minLength",
] as const;

const SCALAR_BOUND_MAX_KEYS = [
  "maximum",
  "exclusiveMaximum",
  "maxLength",
] as const;

const SCALAR_EXACT_MATCH_KEYS = ["pattern", "format", "multipleOf"] as const;

interface SchemaRefExpansionBudget {
  remaining: number;
}

function createRefExpansionBudget(): SchemaRefExpansionBudget {
  return { remaining: MAX_SCHEMA_REF_EXPANSIONS };
}

function consumeRefExpansionBudget(budget: SchemaRefExpansionBudget): boolean {
  if (budget.remaining <= 0) {
    return false;
  }
  budget.remaining -= 1;
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLocalSchemaRef(ref: unknown): ref is string {
  return typeof ref === "string" && (ref === "#" || ref.startsWith("#/"));
}

function normalizeSchemaRefPointer(ref: string): string {
  return ref === "#/" ? "#" : ref;
}

function resolveSchemaPointer(
  root: Record<string, unknown>,
  pointer: string,
): Record<string, unknown> | null {
  if (pointer === "#" || pointer === "#/") {
    return root;
  }
  const parts = pointer
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let target: unknown = root;
  for (const part of parts) {
    if (Array.isArray(target)) {
      if (!/^(?:0|[1-9]\d*)$/.test(part)) {
        return null;
      }
      target = target[Number(part)];
      continue;
    }
    if (!isPlainRecord(target)) {
      return null;
    }
    target = target[part];
  }
  return isPlainRecord(target) ? target : null;
}

function intersectSchemaDefinitions(
  target: unknown,
  sibling: unknown,
): unknown {
  if (!isPlainRecord(target) || !isPlainRecord(sibling)) {
    return sibling !== undefined ? sibling : target;
  }

  const targetLiterals = extractAllowedLiterals(target);
  const siblingLiterals = extractAllowedLiterals(sibling);
  const merged: Record<string, unknown> = {
    ...target,
    ...sibling,
  };

  const typeA = primarySchemaType(target);
  const typeB = primarySchemaType(sibling);
  if (typeA && typeB) {
    if (
      (typeA === "integer" && typeB === "number") ||
      (typeA === "number" && typeB === "integer")
    ) {
      merged.type = "integer";
    } else {
      merged.type = typeB;
    }
  } else if (typeA || typeB) {
    merged.type = typeB ?? typeA;
  }

  if (targetLiterals !== null || siblingLiterals !== null) {
    delete merged.const;
    delete merged.enum;
    const effectiveLiterals =
      targetLiterals !== null && siblingLiterals !== null
        ? targetLiterals.filter((v) => siblingLiterals.includes(v))
        : (siblingLiterals ?? targetLiterals ?? []);
    if (effectiveLiterals.length === 1 && Object.hasOwn(sibling, "const")) {
      merged.const = effectiveLiterals[0];
    } else if (effectiveLiterals.length > 0) {
      merged.enum = [...new Set(effectiveLiterals)];
    }
  }

  if (isPlainRecord(target.properties) || isPlainRecord(sibling.properties)) {
    const mergedProps: Record<string, unknown> = {
      ...(isPlainRecord(target.properties) ? target.properties : {}),
    };
    if (isPlainRecord(sibling.properties)) {
      for (const [key, prop] of Object.entries(sibling.properties)) {
        mergedProps[key] = Object.hasOwn(mergedProps, key)
          ? intersectSchemaDefinitions(mergedProps[key], prop)
          : prop;
      }
    }
    merged.properties = mergedProps;
  }

  if (Array.isArray(target.required) || Array.isArray(sibling.required)) {
    const reqTarget = Array.isArray(target.required)
      ? target.required.filter((k): k is string => typeof k === "string")
      : [];
    const reqSibling = Array.isArray(sibling.required)
      ? sibling.required.filter((k): k is string => typeof k === "string")
      : [];
    const unionReq = [...new Set([...reqTarget, ...reqSibling])];
    if (unionReq.length > 0) {
      merged.required = unionReq;
    } else {
      delete merged.required;
    }
  }

  if (isPlainRecord(target.items) && isPlainRecord(sibling.items)) {
    merged.items = intersectSchemaDefinitions(target.items, sibling.items);
  }

  for (const maxBoundKey of [
    "minimum",
    "exclusiveMinimum",
    "minLength",
    "minItems",
  ] as const) {
    const valA = target[maxBoundKey];
    const valB = sibling[maxBoundKey];
    if (typeof valA === "number" && typeof valB === "number") {
      merged[maxBoundKey] = Math.max(valA, valB);
    }
  }
  for (const minBoundKey of [
    "maximum",
    "exclusiveMaximum",
    "maxLength",
    "maxItems",
  ] as const) {
    const valA = target[minBoundKey];
    const valB = sibling[minBoundKey];
    if (typeof valA === "number" && typeof valB === "number") {
      merged[minBoundKey] = Math.min(valA, valB);
    }
  }

  return merged;
}

function mergeResolvedRefWithSiblings(
  resolvedTarget: Record<string, unknown>,
  siblingNode: Record<string, unknown>,
): Record<string, unknown> {
  const { $ref: _ref, ...siblings } = siblingNode;
  if (Object.keys(siblings).length === 0) {
    return resolvedTarget;
  }
  const intersected = intersectSchemaDefinitions(resolvedTarget, siblings);
  return isPlainRecord(intersected) ? intersected : resolvedTarget;
}

function collapseTypeArray(types: unknown[]): string | undefined {
  const nonNull = types.filter(
    (t): t is string => typeof t === "string" && t !== "null",
  );
  if (nonNull.length === 0) {
    return undefined;
  }
  if (nonNull.includes("number") && nonNull.includes("integer")) {
    const others = nonNull.filter((t) => t !== "number" && t !== "integer");
    if (others.length === 0) {
      return "number";
    }
  }
  return nonNull[0];
}

function primarySchemaType(node: Record<string, unknown>): string | undefined {
  if (typeof node.type === "string") {
    return node.type;
  }
  if (Array.isArray(node.type)) {
    return collapseTypeArray(node.type);
  }
  return undefined;
}

function extractAllowedLiterals(
  prop: Record<string, unknown>,
): unknown[] | null {
  if (Array.isArray(prop.enum)) {
    return prop.enum.filter((entry) => entry !== null);
  }
  if (Object.hasOwn(prop, "const") && prop.const !== null) {
    return [prop.const];
  }
  return null;
}

function inferLiteralSchemaType(literals: unknown[]): string | undefined {
  if (literals.length === 0) {
    return undefined;
  }
  if (literals.every((v) => typeof v === "string")) {
    return "string";
  }
  if (literals.every((v) => typeof v === "number" && Number.isInteger(v))) {
    return "integer";
  }
  if (literals.every((v) => typeof v === "number")) {
    return "number";
  }
  if (literals.every((v) => typeof v === "boolean")) {
    return "boolean";
  }
  return undefined;
}

function effectiveScalarSchemaType(
  node: Record<string, unknown>,
  literals: unknown[] | null,
): string | undefined {
  const declared = primarySchemaType(node);
  const inferred =
    literals !== null ? inferLiteralSchemaType(literals) : undefined;
  if (
    (declared === "integer" && inferred === "number") ||
    (declared === "number" && inferred === "integer")
  ) {
    return "number";
  }
  return declared ?? inferred;
}

function widenScalarBranchSchemas(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  mergedType: string | undefined,
): Record<string, unknown> {
  const {
    const: _c1,
    enum: _e1,
    minimum: _min1,
    maximum: _max1,
    exclusiveMinimum: _exMin1,
    exclusiveMaximum: _exMax1,
    minLength: _minLen1,
    maxLength: _maxLen1,
    pattern: _pat1,
    format: _fmt1,
    multipleOf: _mul1,
    ...rest
  } = existing;
  const description =
    typeof existing.description === "string" && existing.description
      ? { description: existing.description }
      : typeof incoming.description === "string" && incoming.description
        ? { description: incoming.description }
        : {};
  const widened: Record<string, unknown> = {
    ...rest,
    ...description,
    ...(mergedType ? { type: mergedType } : {}),
  };
  for (const key of SCALAR_BOUND_MIN_KEYS) {
    const valA = existing[key];
    const valB = incoming[key];
    if (typeof valA === "number" && typeof valB === "number") {
      widened[key] = Math.min(valA, valB);
    }
  }
  for (const key of SCALAR_BOUND_MAX_KEYS) {
    const valA = existing[key];
    const valB = incoming[key];
    if (typeof valA === "number" && typeof valB === "number") {
      widened[key] = Math.max(valA, valB);
    }
  }
  for (const key of SCALAR_EXACT_MATCH_KEYS) {
    if (existing[key] !== undefined && existing[key] === incoming[key]) {
      widened[key] = existing[key];
    }
  }
  return widened;
}

function mergeUnionPropertySchemas(
  existing: unknown,
  incoming: unknown,
): unknown {
  if (!isPlainRecord(existing) || !isPlainRecord(incoming)) {
    return existing;
  }

  const existingLiterals = extractAllowedLiterals(existing);
  const incomingLiterals = extractAllowedLiterals(incoming);
  if (existingLiterals !== null && incomingLiterals !== null) {
    const mergedLiterals = [
      ...new Set([...existingLiterals, ...incomingLiterals]),
    ];
    const allStrings = mergedLiterals.every((v) => typeof v === "string");
    const allIntegers = mergedLiterals.every(
      (v) => typeof v === "number" && Number.isInteger(v),
    );
    const allNumbers = mergedLiterals.every((v) => typeof v === "number");
    const typeA = effectiveScalarSchemaType(existing, existingLiterals);
    const typeB = effectiveScalarSchemaType(incoming, incomingLiterals);
    const mergedType =
      typeA && typeB && typeA !== typeB
        ? allStrings
          ? "string"
          : allNumbers
            ? "number"
            : "string"
        : allNumbers && !allIntegers
          ? "number"
          : (typeA ??
            typeB ??
            (allStrings
              ? "string"
              : allIntegers
                ? "integer"
                : allNumbers
                  ? "number"
                  : undefined));
    const widenedBase = widenScalarBranchSchemas(
      existing,
      incoming,
      mergedType,
    );
    return {
      ...widenedBase,
      enum: mergedLiterals.map((v) =>
        mergedType === "string" && typeof v !== "string" ? String(v) : v,
      ),
    };
  }

  if (existingLiterals !== null || incomingLiterals !== null) {
    const base = existingLiterals !== null ? existing : incoming;
    const baseLiterals =
      existingLiterals !== null ? existingLiterals : incomingLiterals;
    const other = existingLiterals !== null ? incoming : existing;
    const typeA = effectiveScalarSchemaType(base, baseLiterals);
    const typeB = effectiveScalarSchemaType(other, null);
    const isNumPair =
      (typeA === "integer" && typeB === "number") ||
      (typeA === "number" && typeB === "integer");
    const mergedType =
      typeA && typeB && typeA !== typeB
        ? isNumPair
          ? "number"
          : "string"
        : (typeA ?? typeB);
    return widenScalarBranchSchemas(base, other, mergedType);
  }

  const typeA = primarySchemaType(existing);
  const typeB = primarySchemaType(incoming);
  if (
    typeA === "object" ||
    typeB === "object" ||
    isPlainRecord(existing.properties) ||
    isPlainRecord(incoming.properties)
  ) {
    if ((typeA && typeA !== "object") || (typeB && typeB !== "object")) {
      const description =
        typeof existing.description === "string" && existing.description
          ? { description: existing.description }
          : typeof incoming.description === "string" && incoming.description
            ? { description: incoming.description }
            : {};
      return { type: "string", ...description };
    }
    const existingProps = isPlainRecord(existing.properties)
      ? existing.properties
      : {};
    const incomingProps = isPlainRecord(incoming.properties)
      ? incoming.properties
      : {};
    const mergedProps: Record<string, unknown> = { ...existingProps };
    for (const [k, v] of Object.entries(incomingProps)) {
      mergedProps[k] = Object.hasOwn(mergedProps, k)
        ? mergeUnionPropertySchemas(mergedProps[k], v)
        : v;
    }
    const reqA = Array.isArray(existing.required)
      ? new Set(
          existing.required.filter((k): k is string => typeof k === "string"),
        )
      : new Set<string>();
    const reqB = Array.isArray(incoming.required)
      ? new Set(
          incoming.required.filter((k): k is string => typeof k === "string"),
        )
      : new Set<string>();
    const commonReq = [...reqA].filter((k) => reqB.has(k));
    const {
      required: _r,
      properties: _p,
      minProperties: _minP,
      maxProperties: _maxP,
      ...rest
    } = existing;
    return {
      ...rest,
      type: "object",
      ...(Object.keys(mergedProps).length > 0
        ? { properties: mergedProps }
        : {}),
      ...(commonReq.length > 0 ? { required: commonReq } : {}),
    };
  }

  if (
    (typeA === "array" || isPlainRecord(existing.items)) &&
    (typeB === "array" || isPlainRecord(incoming.items))
  ) {
    const {
      minItems: minA,
      maxItems: maxA,
      uniqueItems: uniqA,
      items: itemsA,
      ...rest
    } = existing;
    const minB = incoming.minItems;
    const maxB = incoming.maxItems;
    const uniqB = incoming.uniqueItems;
    const itemsB = incoming.items;
    const mergedItems =
      isPlainRecord(itemsA) && isPlainRecord(itemsB)
        ? mergeUnionPropertySchemas(itemsA, itemsB)
        : undefined;
    return {
      ...rest,
      type: "array",
      ...(mergedItems ? { items: mergedItems } : {}),
      ...(typeof minA === "number" && typeof minB === "number"
        ? { minItems: Math.min(minA, minB) }
        : {}),
      ...(typeof maxA === "number" && typeof maxB === "number"
        ? { maxItems: Math.max(maxA, maxB) }
        : {}),
      ...(uniqA === true && uniqB === true ? { uniqueItems: true } : {}),
    };
  }
  if (typeA && typeB && typeA !== typeB) {
    const isNumPair =
      (typeA === "integer" && typeB === "number") ||
      (typeA === "number" && typeB === "integer");
    if (isNumPair) {
      return widenScalarBranchSchemas(existing, incoming, "number");
    }
    const description =
      typeof existing.description === "string" && existing.description
        ? { description: existing.description }
        : typeof incoming.description === "string" && incoming.description
          ? { description: incoming.description }
          : {};
    return { type: "string", ...description };
  }

  return widenScalarBranchSchemas(existing, incoming, typeA ?? typeB);
}

function collapseAllOfInRecord(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  seenRefs: Set<string>,
  refBudget: SchemaRefExpansionBudget,
): Record<string, unknown> {
  if (!Array.isArray(node.allOf)) {
    return node;
  }
  const { allOf, ...rest } = node;
  let combined: Record<string, unknown> = rest;
  for (const part of allOf) {
    if (isPlainRecord(part)) {
      let collapsedPart = collapseAllOfInRecord(
        part,
        root,
        seenRefs,
        refBudget,
      );
      if (
        Array.isArray(collapsedPart.anyOf) ||
        Array.isArray(collapsedPart.oneOf)
      ) {
        const flattenedPart = flattenUnionObjectSchema(
          collapsedPart,
          root,
          seenRefs,
          refBudget,
        );
        if (flattenedPart) {
          collapsedPart = flattenedPart;
        }
      }
      const intersected = intersectSchemaDefinitions(combined, collapsedPart);
      if (isPlainRecord(intersected)) {
        combined = intersected;
      }
    }
  }
  return combined;
}

function flattenUnionObjectSchema(
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
  seenRefs = new Set<string>(["#"]),
  refBudget = createRefExpansionBudget(),
): Record<string, unknown> | null {
  function deref(node: unknown, seen = new Set<string>(seenRefs)): unknown {
    if (Array.isArray(node)) {
      return node.map((item) => deref(item, seen));
    }
    if (!isPlainRecord(node)) {
      return node;
    }
    if (isLocalSchemaRef(node.$ref)) {
      const normalizedRef = normalizeSchemaRefPointer(node.$ref);
      const description =
        typeof node.description === "string" && node.description
          ? { description: node.description }
          : {};
      if (seen.has(normalizedRef) || !consumeRefExpansionBudget(refBudget)) {
        return { type: "string", ...description };
      }
      const target = resolveSchemaPointer(root, normalizedRef);
      if (!target) {
        return { type: "string", ...description };
      }
      const nextSeen = new Set([...seen, normalizedRef]);
      const resolvedTarget = deref(target, nextSeen);
      if (!isPlainRecord(resolvedTarget)) {
        return { type: "string", ...description };
      }
      const resolvedSiblings = deref(
        Object.fromEntries(
          Object.entries(node).filter(([key]) => key !== "$ref"),
        ),
        seen,
      );
      return isPlainRecord(resolvedSiblings)
        ? mergeResolvedRefWithSiblings(resolvedTarget, resolvedSiblings)
        : { ...resolvedTarget, ...description };
    }
    const derefedEntries = Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !STRIPPED_SCHEMA_KEYWORDS.has(key))
        .map(([key, item]) => {
          if (LITERAL_SCHEMA_FIELDS.has(key)) {
            return [key, item];
          }
          if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(item)) {
            return [
              key,
              Object.fromEntries(
                Object.entries(item).map(([propName, propSchema]) => [
                  propName,
                  deref(propSchema, seen),
                ]),
              ),
            ];
          }
          return [key, deref(item, seen)];
        }),
    );
    return collapseAllOfInRecord(derefedEntries, root, seen, refBudget);
  }

  const resolved = deref(schema);
  if (!isPlainRecord(resolved)) {
    return null;
  }

  const properties: Record<string, unknown> = {};
  const parentRequired = Array.isArray(resolved.required)
    ? resolved.required.filter((key): key is string => typeof key === "string")
    : [];
  const branchRequiredSets: Set<string>[] = [];

  function collectProperties(propsRecord: Record<string, unknown>): void {
    for (const [key, prop] of Object.entries(propsRecord)) {
      const normalizedProp = normalizeCopilotToolSchema(
        prop,
        root,
        seenRefs,
        refBudget,
      );
      if (!Object.hasOwn(properties, key)) {
        properties[key] = normalizedProp;
      } else {
        properties[key] = mergeUnionPropertySchemas(
          properties[key],
          normalizedProp,
        );
      }
    }
  }

  function collectBranch(
    rawNode: unknown,
    inheritedRequired = new Set<string>(),
  ): void {
    if (!isPlainRecord(rawNode)) {
      return;
    }
    const node = collapseAllOfInRecord(rawNode, root, seenRefs, refBudget);
    const oneOf = Array.isArray(node.oneOf) ? node.oneOf : [];
    const anyOf = Array.isArray(node.anyOf) ? node.anyOf : [];
    const subBranches = [...oneOf, ...anyOf];
    const ownRequired = Array.isArray(node.required)
      ? node.required.filter((key): key is string => typeof key === "string")
      : [];
    const combinedRequired = new Set(
      [...inheritedRequired, ownRequired].flat(),
    );

    if (
      isPlainRecord(node.properties) &&
      Object.keys(node.properties).length > 0
    ) {
      collectProperties(node.properties);
    }

    if (subBranches.length > 0) {
      for (const branch of subBranches) {
        collectBranch(branch, combinedRequired);
      }
      return;
    }

    const branchType = primarySchemaType(node);
    const hasIncompatibleConstraint =
      (branchType !== undefined && branchType !== "object") ||
      node.type === "null" ||
      isPlainRecord(node.items) ||
      extractAllowedLiterals(node) !== null;
    if (!hasIncompatibleConstraint) {
      branchRequiredSets.push(combinedRequired);
    }
  }

  if (
    isPlainRecord(resolved.properties) &&
    Object.keys(resolved.properties).length > 0
  ) {
    collectProperties(resolved.properties);
  }
  const topBranches = [
    ...(Array.isArray(resolved.oneOf) ? resolved.oneOf : []),
    ...(Array.isArray(resolved.anyOf) ? resolved.anyOf : []),
  ];
  for (const branch of topBranches) {
    collectBranch(branch);
  }

  if (Object.keys(properties).length === 0) {
    return null;
  }

  const intersectedBranchRequired =
    branchRequiredSets.length > 0
      ? [...branchRequiredSets[0]].filter((key) =>
          branchRequiredSets.every((set) => set.has(key)),
        )
      : [];

  const commonRequired = [
    ...new Set([...parentRequired, ...intersectedBranchRequired]),
  ].filter((key) => Object.hasOwn(properties, key));

  const normalizedProperties = Object.fromEntries(
    Object.entries(properties).map(([key, prop]) => [
      key,
      normalizeCopilotToolSchema(prop, root, seenRefs, refBudget),
    ]),
  );

  const parentAnnotations = Object.fromEntries(
    Object.entries(resolved)
      .filter(
        ([key]) =>
          !STRIPPED_SCHEMA_KEYWORDS.has(key) &&
          ![
            "anyOf",
            "oneOf",
            "allOf",
            "type",
            "properties",
            "required",
            "enum",
            "const",
          ].includes(key),
      )
      .map(([key, item]) => [
        key,
        LITERAL_SCHEMA_FIELDS.has(key)
          ? item
          : normalizeCopilotToolSchema(item, root, seenRefs, refBudget),
      ]),
  );

  return {
    ...parentAnnotations,
    type: "object",
    properties: normalizedProperties,
    ...(commonRequired.length > 0 ? { required: commonRequired } : {}),
  };
}

function extractNameOnlyBranchDiscriminator(
  option: unknown,
  root: Record<string, unknown>,
  seenRefs: Set<string>,
  refBudget: SchemaRefExpansionBudget,
): { names: string[]; requiresName: boolean } | null {
  if (!isPlainRecord(option)) {
    return null;
  }
  let resolved: Record<string, unknown> = option;
  if (isLocalSchemaRef(option.$ref)) {
    const normalizedRef = normalizeSchemaRefPointer(option.$ref);
    if (seenRefs.has(normalizedRef) || !consumeRefExpansionBudget(refBudget)) {
      return null;
    }
    const target = resolveSchemaPointer(root, normalizedRef);
    if (!target) {
      return null;
    }
    resolved = mergeResolvedRefWithSiblings(target, option);
  }
  resolved = collapseAllOfInRecord(resolved, root, seenRefs, refBudget);
  if (!isPlainRecord(resolved.properties)) {
    return null;
  }
  const propKeys = Object.keys(resolved.properties);
  if (propKeys.length !== 1 || propKeys[0] !== "name") {
    return null;
  }
  const branchRequired = Array.isArray(resolved.required)
    ? resolved.required.filter((req): req is string => typeof req === "string")
    : [];
  if (branchRequired.some((req) => req !== "name")) {
    return null;
  }
  const nameProp = resolved.properties.name;
  if (!isPlainRecord(nameProp)) {
    return null;
  }
  const names = Array.isArray(nameProp.enum)
    ? nameProp.enum.filter((v): v is string => typeof v === "string")
    : typeof nameProp.const === "string"
      ? [nameProp.const]
      : [];
  if (names.length === 0) {
    return null;
  }
  return {
    names,
    requiresName: branchRequired.includes("name"),
  };
}

function tryCollapseNameDiscriminatedItemUnion(
  current: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
  seenRefs: Set<string>,
  refBudget: SchemaRefExpansionBudget,
): Record<string, unknown> | null {
  const currentItems = isPlainRecord(current.items) ? current.items : undefined;
  const itemAnyOf = Array.isArray(currentItems?.anyOf)
    ? currentItems.anyOf
    : undefined;
  const nonNullBranches = itemAnyOf?.filter(
    (option) => isPlainRecord(option) && option.type !== "null",
  );
  if (!currentItems || !nonNullBranches || nonNullBranches.length <= 4) {
    return null;
  }
  const parentRequired = Array.isArray(currentItems.required)
    ? currentItems.required.filter((r): r is string => typeof r === "string")
    : [];
  if (parentRequired.some((r) => r !== "name")) {
    return null;
  }
  const branchInfos = nonNullBranches.map((option) =>
    extractNameOnlyBranchDiscriminator(option, rootSchema, seenRefs, refBudget),
  );
  if (
    branchInfos.some(
      (info): info is null => info === null || info.names.length === 0,
    )
  ) {
    return null;
  }
  const validInfos = branchInfos as Array<{
    names: string[];
    requiresName: boolean;
  }>;
  const mergedNames = [...new Set(validInfos.flatMap((info) => info.names))];
  const itemType = primarySchemaType(currentItems) ?? "object";
  const normalizedContainer = Object.fromEntries(
    Object.entries(current)
      .filter(([key]) => !STRIPPED_SCHEMA_KEYWORDS.has(key) && key !== "items")
      .map(([key, item]) => [
        key,
        LITERAL_SCHEMA_FIELDS.has(key)
          ? item
          : normalizeCopilotToolSchema(item, rootSchema, seenRefs, refBudget),
      ]),
  );
  const collapsedItemSchema: Record<string, unknown> = {
    type: itemType,
    properties: { name: { type: "string", enum: mergedNames } },
  };
  if (
    parentRequired.includes("name") ||
    validInfos.every((info) => info.requiresName)
  ) {
    collapsedItemSchema.required = ["name"];
  }
  const { anyOf: _itemAnyOf, ...parentItemWithoutAnyOf } = currentItems;
  const normalizedParentItems =
    Object.keys(parentItemWithoutAnyOf).length > 0
      ? normalizeCopilotToolSchema(
          parentItemWithoutAnyOf,
          rootSchema,
          seenRefs,
          refBudget,
        )
      : undefined;
  const mergedItemSchema = isPlainRecord(normalizedParentItems)
    ? intersectSchemaDefinitions(normalizedParentItems, collapsedItemSchema)
    : collapsedItemSchema;
  return {
    ...normalizedContainer,
    items: isPlainRecord(mergedItemSchema)
      ? mergedItemSchema
      : collapsedItemSchema,
  };
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

/**
 * Normalize complex JSON Schema constructs ($ref/$defs, nullable type arrays,
 * array-level enums, and large discriminated items.anyOf unions) that Copilot
 * Gemini backends reject with HTTP 400 invalid_request_body.
 */
export function normalizeCopilotToolSchema(
  value: unknown,
  root?: Record<string, unknown>,
  seenRefs = new Set<string>(),
  refBudget = createRefExpansionBudget(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeCopilotToolSchema(item, root, seenRefs, refBudget),
    );
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const obj = value;
  const rootSchema = root ?? obj;
  const effectiveSeenRefs =
    root === undefined ? new Set([...seenRefs, "#"]) : seenRefs;

  if (isLocalSchemaRef(obj.$ref)) {
    const normalizedRef = normalizeSchemaRefPointer(obj.$ref);
    const description =
      typeof obj.description === "string" && obj.description
        ? { description: obj.description }
        : {};
    if (
      effectiveSeenRefs.has(normalizedRef) ||
      !consumeRefExpansionBudget(refBudget)
    ) {
      return { type: "string", ...description };
    }
    const target = resolveSchemaPointer(rootSchema, normalizedRef);
    if (!target) {
      return { type: "string", ...description };
    }
    const nextSeen = new Set([...effectiveSeenRefs, normalizedRef]);
    const resolved = normalizeCopilotToolSchema(
      target,
      rootSchema,
      nextSeen,
      refBudget,
    );
    if (!isPlainRecord(resolved)) {
      return { type: "string", ...description };
    }
    const siblingEntries = Object.entries(obj).filter(
      ([key]) => key !== "$ref",
    );
    if (siblingEntries.length === 0) {
      return resolved;
    }
    const normalizedSiblings = normalizeCopilotToolSchema(
      Object.fromEntries(siblingEntries),
      rootSchema,
      effectiveSeenRefs,
      refBudget,
    );
    if (!isPlainRecord(normalizedSiblings)) {
      return { ...resolved, ...description };
    }
    const mergedRef = mergeResolvedRefWithSiblings(
      resolved,
      normalizedSiblings,
    );
    const normalizedMergedRef = normalizeCopilotToolSchema(
      mergedRef,
      rootSchema,
      effectiveSeenRefs,
      refBudget,
    );
    return isPlainRecord(normalizedMergedRef) ? normalizedMergedRef : mergedRef;
  }

  if (Array.isArray(obj.allOf)) {
    const { allOf, ...rest } = obj;
    const normalizedRest = normalizeCopilotToolSchema(
      rest,
      rootSchema,
      effectiveSeenRefs,
      refBudget,
    );
    let combined: Record<string, unknown> = isPlainRecord(normalizedRest)
      ? normalizedRest
      : {};
    for (const part of allOf) {
      const normalizedPart = normalizeCopilotToolSchema(
        part,
        rootSchema,
        effectiveSeenRefs,
        refBudget,
      );
      if (isPlainRecord(normalizedPart)) {
        const intersected = intersectSchemaDefinitions(
          combined,
          normalizedPart,
        );
        if (isPlainRecord(intersected)) {
          combined = intersected;
        }
      }
    }
    const normalizedCombined = normalizeCopilotToolSchema(
      combined,
      rootSchema,
      effectiveSeenRefs,
      refBudget,
    );
    return isPlainRecord(normalizedCombined) ? normalizedCombined : combined;
  }

  const hasEmptyProperties =
    !isPlainRecord(obj.properties) || Object.keys(obj.properties).length === 0;

  if (
    (Array.isArray(obj.oneOf) || Array.isArray(obj.anyOf)) &&
    hasEmptyProperties
  ) {
    const flattened = flattenUnionObjectSchema(
      obj,
      rootSchema,
      effectiveSeenRefs,
      refBudget,
    );
    if (flattened) {
      return flattened;
    }
    const union = (
      Array.isArray(obj.anyOf) ? obj.anyOf : obj.oneOf
    ) as unknown[];
    const nonNull = union.filter(
      (branch): branch is Record<string, unknown> =>
        isPlainRecord(branch) && branch.type !== "null",
    );
    const {
      anyOf: _anyOf,
      oneOf: _oneOf,
      $defs: _defs,
      definitions: _definitions,
      additionalProperties: _addProps,
      ...parentConstraints
    } = obj;
    const parentType = primarySchemaType(parentConstraints);
    if (parentType) {
      parentConstraints.type = parentType;
    } else {
      delete parentConstraints.type;
    }
    const description =
      typeof obj.description === "string" && obj.description
        ? { description: obj.description }
        : {};
    const applyParentToBranch = (
      branch: Record<string, unknown>,
    ): Record<string, unknown> => {
      if (Object.keys(parentConstraints).length === 0) {
        return branch;
      }
      const combined = intersectSchemaDefinitions(parentConstraints, branch);
      if (!isPlainRecord(combined)) {
        return branch;
      }
      const normalizedCombined = normalizeCopilotToolSchema(
        combined,
        rootSchema,
        effectiveSeenRefs,
        refBudget,
      );
      return isPlainRecord(normalizedCombined) ? normalizedCombined : combined;
    };
    if (nonNull.length === 1) {
      const resolved = normalizeCopilotToolSchema(
        nonNull[0],
        rootSchema,
        effectiveSeenRefs,
        refBudget,
      );
      return isPlainRecord(resolved)
        ? { ...applyParentToBranch(resolved), ...description }
        : { type: parentType ?? "string", ...description };
    }
    if (nonNull.length > 1) {
      const normalizedBranches = nonNull
        .map((branch) =>
          normalizeCopilotToolSchema(
            branch,
            rootSchema,
            effectiveSeenRefs,
            refBudget,
          ),
        )
        .filter(isPlainRecord)
        .map(applyParentToBranch);
      if (
        normalizedBranches.length > 0 &&
        normalizedBranches.every(
          (branch) =>
            primarySchemaType(branch) === "array" ||
            isPlainRecord(branch.items),
        )
      ) {
        const mergedArray = normalizedBranches
          .slice(1)
          .reduce<unknown>(
            (acc, branch) => mergeUnionPropertySchemas(acc, branch),
            normalizedBranches[0],
          );
        const normalizedMerged = normalizeCopilotToolSchema(
          mergedArray,
          rootSchema,
          effectiveSeenRefs,
          refBudget,
        );
        if (isPlainRecord(normalizedMerged)) {
          return { ...normalizedMerged, ...description };
        }
      }
      const mergedBranch =
        normalizedBranches.length > 0
          ? normalizedBranches
              .slice(1)
              .reduce<unknown>(
                (acc, branch) => mergeUnionPropertySchemas(acc, branch),
                normalizedBranches[0],
              )
          : undefined;
      if (
        isPlainRecord(mergedBranch) &&
        typeof mergedBranch.type === "string" &&
        mergedBranch.type !== "array"
      ) {
        return { ...mergedBranch, ...description };
      }
      const primaryType =
        (typeof parentType === "string" && parentType !== "array"
          ? parentType
          : undefined) ??
        normalizedBranches.find(
          (branch) =>
            typeof branch.type === "string" && branch.type !== "array",
        )?.type ??
        "string";
      return { type: primaryType, ...description };
    }
  }

  let current: Record<string, unknown> = obj;
  if (Array.isArray(current.type)) {
    current = {
      ...current,
      type: collapseTypeArray(current.type) ?? "string",
    };
  }
  if (Array.isArray(current.enum) && current.enum.includes(null)) {
    current = {
      ...current,
      enum: current.enum.filter((entry) => entry !== null),
    };
  }
  if (
    Array.isArray(current.enum) &&
    typeof current.type === "string" &&
    !["string", "integer", "number"].includes(current.type)
  ) {
    const { enum: enumValues, ...rest } = current;
    const items = isPlainRecord(current.items) ? current.items : undefined;
    const itemType = items ? primarySchemaType(items) : undefined;
    const isCompatibleScalarEnum =
      enumValues.length > 0 &&
      enumValues.every((entry) =>
        isCompatibleScalarForItemType(entry, itemType),
      );
    current =
      current.type === "array" &&
      isCompatibleScalarEnum &&
      items &&
      !Array.isArray(items.enum)
        ? {
            ...rest,
            items: {
              ...items,
              enum: enumValues,
            },
          }
        : rest;
  }

  const collapsedItemUnion = tryCollapseNameDiscriminatedItemUnion(
    current,
    rootSchema,
    effectiveSeenRefs,
    refBudget,
  );
  if (collapsedItemUnion) {
    return collapsedItemUnion;
  }

  return Object.fromEntries(
    Object.entries(current)
      .filter(([key]) => !STRIPPED_SCHEMA_KEYWORDS.has(key))
      .map(([key, item]) => {
        if (LITERAL_SCHEMA_FIELDS.has(key)) {
          return [key, item];
        }
        if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(item)) {
          return [
            key,
            Object.fromEntries(
              Object.entries(item).map(([propName, propSchema]) => [
                propName,
                normalizeCopilotToolSchema(
                  propSchema,
                  rootSchema,
                  effectiveSeenRefs,
                  refBudget,
                ),
              ]),
            ),
          ];
        }
        return [
          key,
          normalizeCopilotToolSchema(
            item,
            rootSchema,
            effectiveSeenRefs,
            refBudget,
          ),
        ];
      }),
  );
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
  if (!isCopilotGemini || !Array.isArray(tools)) {
    return tools;
  }
  return tools.map((tool) =>
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? {
          ...tool,
          inputSchema: normalizeCopilotToolSchema(tool.inputSchema) as object,
        }
      : tool,
  );
}
