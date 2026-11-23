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
  "prefixItems",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getSchemaTypes(node: Record<string, unknown>): string[] | undefined {
  if (typeof node.type === "string") {
    return [node.type];
  }
  if (Array.isArray(node.type)) {
    const types = node.type.filter((t): t is string => typeof t === "string");
    return types.length > 0 ? types : undefined;
  }
  return undefined;
}

function formatSchemaTypes(types: string[]): string | string[] {
  return types.length === 1 ? types[0] : types;
}

function intersectSchemaTypes(
  parentTypes: string[],
  branchTypes: string[],
): string[] {
  return branchTypes.filter(
    (bt) =>
      parentTypes.includes(bt) ||
      (bt === "integer" && parentTypes.includes("number")),
  );
}

function isScalarMatchesType(entry: unknown, typeName: string): boolean {
  if (typeName === "string") {
    return typeof entry === "string";
  }
  if (typeName === "integer") {
    return typeof entry === "number" && Number.isInteger(entry);
  }
  if (typeName === "number") {
    return typeof entry === "number" && Number.isFinite(entry);
  }
  if (typeName === "boolean") {
    return typeof entry === "boolean";
  }
  return false;
}

function isCompatibleScalarForItemTypes(
  entry: unknown,
  itemTypes: string[] | undefined,
): boolean {
  if (entry === null || typeof entry === "object") {
    return false;
  }
  if (!itemTypes || itemTypes.length === 0) {
    return (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    );
  }
  return itemTypes.some((t) => t !== "null" && isScalarMatchesType(entry, t));
}

function hasAnyLocalReference(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const item of cur) {
        stack.push(item);
      }
      continue;
    }
    if (!isPlainRecord(cur)) {
      continue;
    }
    if (typeof cur.$ref === "string" || typeof cur.$dynamicRef === "string") {
      return true;
    }
    for (const [key, val] of Object.entries(cur)) {
      if (LITERAL_SCHEMA_FIELDS.has(key)) {
        continue;
      }
      stack.push(val);
    }
  }
  return false;
}

/**
 * Copilot Gemini accepts `{ anyOf: [...] }` / `{ oneOf: [...] }`, but rejects
 * schema nodes that combine `anyOf` / `oneOf` with sibling `type`,
 * `properties`, or `required` keywords on the same object (for example
 * Microsoft 365 WorkIQ MCP `retrieve.parameters.properties.capabilities.items`).
 *
 * When a union node declares no non-empty parent `properties` (either no
 * `properties` or `properties: {}` without sibling closure keywords), push
 * parent `type` and `required` directly into the union branches. When the parent
 * declares non-empty `properties` or closure keywords alongside `properties: {}`,
 * keep parent `properties` and `type` in place and isolate the union (plus any
 * `required` keys not declared in parent `properties`) inside `allOf`.
 */
function distributeUnionSiblingKeywords(
  node: Record<string, unknown>,
  hasRefsInTree: boolean,
): Record<string, unknown> | null {
  const hasAnyOf = Array.isArray(node.anyOf);
  const hasOneOf = Array.isArray(node.oneOf);
  if (!hasAnyOf && !hasOneOf) {
    return null;
  }
  if (
    !Object.hasOwn(node, "type") &&
    !Object.hasOwn(node, "properties") &&
    !Object.hasOwn(node, "required")
  ) {
    return null;
  }

  const parentProps = isPlainRecord(node.properties)
    ? node.properties
    : undefined;
  const parentPropKeys = parentProps ? Object.keys(parentProps) : [];
  const hasNonEmptyParentProps = parentPropKeys.length > 0;
  const hasEmptyParentPropsWithClosure =
    parentProps !== undefined &&
    parentPropKeys.length === 0 &&
    (Object.hasOwn(node, "additionalProperties") ||
      Object.hasOwn(node, "unevaluatedProperties"));

  // Path A: Parent has non-empty `properties` (or `properties: {}` with closure
  // keywords), or declares both `anyOf` and `oneOf`. Keep `properties` and
  // `type` on the parent and isolate the union(s) in `allOf` when no `$ref`
  // pointers in the tree could target the union path.
  if (
    hasNonEmptyParentProps ||
    hasEmptyParentPropsWithClosure ||
    (hasAnyOf && hasOneOf)
  ) {
    if (hasRefsInTree) {
      return null;
    }
    const parentTypes = getSchemaTypes(node);
    const parentRequired = Array.isArray(node.required)
      ? node.required.filter((k): k is string => typeof k === "string")
      : undefined;
    const declaredPropSet = new Set(parentPropKeys);
    const retainedRequired =
      parentRequired && hasNonEmptyParentProps
        ? parentRequired.filter((k) => declaredPropSet.has(k))
        : [];
    const deferredRequired = parentRequired
      ? hasNonEmptyParentProps
        ? parentRequired.filter((k) => !declaredPropSet.has(k))
        : parentRequired
      : [];

    const existingAllOf = Array.isArray(node.allOf) ? node.allOf : [];
    const nextAllOf: unknown[] = [...existingAllOf];
    if (deferredRequired.length > 0) {
      nextAllOf.push({ required: deferredRequired });
    }
    if (hasAnyOf) {
      nextAllOf.push({ anyOf: node.anyOf });
    }
    if (hasOneOf) {
      nextAllOf.push({ oneOf: node.oneOf });
    }

    const {
      anyOf: _anyOf,
      oneOf: _oneOf,
      required: _req,
      allOf: _allOf,
      ...rest
    } = node;
    const result: Record<string, unknown> = { ...rest };
    if (hasNonEmptyParentProps && !parentTypes) {
      result.type = "object";
    }
    if (retainedRequired.length > 0) {
      result.required = retainedRequired;
    }
    result.allOf = nextAllOf;
    return result;
  }

  // Path B: Parent has no `properties` (or empty `properties: {}` without
  // closure keywords). Distribute `type` and `required` into each branch.
  const unionKey = hasAnyOf ? "anyOf" : "oneOf";
  const rawBranches = node[unionKey] as unknown[];
  const parentTypes = getSchemaTypes(node);
  const parentRequired = Array.isArray(node.required)
    ? node.required.filter((k): k is string => typeof k === "string")
    : [];
  const parentItems = isPlainRecord(node.items) ? node.items : undefined;
  const parentItemTypes = parentItems ? getSchemaTypes(parentItems) : undefined;

  // Avoid altering branch array indices or adding sibling keywords to `$ref`
  // branches when the schema tree contains `$ref`.
  if (
    hasRefsInTree &&
    rawBranches.some(
      (b) =>
        typeof b === "boolean" ||
        (isPlainRecord(b) &&
          (typeof b.$ref === "string" || typeof b.$dynamicRef === "string")),
    )
  ) {
    return null;
  }

  let hasUnsatisfiableBranch = false;
  const branches: unknown[] = [];

  for (const branch of rawBranches) {
    if (branch === false) {
      hasUnsatisfiableBranch = true;
      continue;
    }
    if (branch !== true && !isPlainRecord(branch)) {
      branches.push(branch);
      continue;
    }
    let branchObj: Record<string, unknown> =
      branch === true ? {} : { ...branch };

    if (parentTypes) {
      const branchTypes = getSchemaTypes(branchObj);
      if (branchTypes) {
        const intersected = intersectSchemaTypes(parentTypes, branchTypes);
        if (intersected.length === 0) {
          hasUnsatisfiableBranch = true;
          continue;
        }
        branchObj.type = formatSchemaTypes(intersected);
      } else {
        branchObj.type = formatSchemaTypes(parentTypes);
      }
    }

    // If propagating parent `type: "array"` created an array-level `enum` on
    // the branch, relocate or strip it immediately.
    const relocatedBranch = relocateArrayLevelEnum(branchObj, parentItemTypes);
    if (relocatedBranch) {
      branchObj = relocatedBranch;
    }

    if (parentRequired.length > 0) {
      const branchTypesAfter = getSchemaTypes(branchObj);
      const isPureNullBranch =
        branchTypesAfter !== undefined &&
        branchTypesAfter.length === 1 &&
        branchTypesAfter[0] === "null" &&
        !isPlainRecord(branchObj.properties) &&
        !Array.isArray(branchObj.required);
      if (!isPureNullBranch) {
        const branchReq = Array.isArray(branchObj.required)
          ? branchObj.required.filter((k): k is string => typeof k === "string")
          : [];
        branchObj.required = [...new Set([...parentRequired, ...branchReq])];
      }
    }

    branches.push(branchObj);
  }

  if (branches.length === 0) {
    if (hasRefsInTree || !hasUnsatisfiableBranch) {
      return null;
    }
    const {
      type: _t,
      properties: _p,
      required: _r,
      [unionKey]: _u,
      ...rest
    } = node;
    return {
      ...rest,
      not: {},
    };
  }

  const { type: _t, properties: _p, required: _r, ...rest } = node;
  return {
    ...rest,
    [unionKey]: branches,
  };
}

/**
 * Copilot Gemini rejects `enum` declared on `type: "array"` (for example IcM
 * MCP `search_incidents.parameters.properties.severity`). Move compatible
 * scalar enum choices onto `items.enum`, or strip unsupported array-level
 * enums on array schemas.
 */
function relocateArrayLevelEnum(
  node: Record<string, unknown>,
  inheritedItemTypes?: string[],
): Record<string, unknown> | null {
  if (!Array.isArray(node.enum)) {
    return null;
  }
  const types = getSchemaTypes(node);
  if (!types || !types.includes("array")) {
    return null;
  }
  const nonNullTypes = types.filter((t) => t !== "null");
  if (nonNullTypes.length !== 1 || nonNullTypes[0] !== "array") {
    return null;
  }

  const nonNullEnum = node.enum.filter((entry) => entry !== null);
  const { enum: _enumValues, ...rest } = node;

  // A nullable array with `enum: [null]` only permits `null`.
  if (
    nonNullEnum.length === 0 &&
    node.enum.length > 0 &&
    types.includes("null")
  ) {
    return {
      ...rest,
      type: "null",
    };
  }

  if (Array.isArray(node.items) || node.items === false) {
    return rest;
  }

  const items = isPlainRecord(node.items) ? node.items : {};
  const ownItemTypes = getSchemaTypes(items);
  const effectiveItemTypes =
    ownItemTypes && inheritedItemTypes
      ? intersectSchemaTypes(inheritedItemTypes, ownItemTypes)
      : (ownItemTypes ?? inheritedItemTypes);
  const hasIncompatibleItemTypes =
    Boolean(ownItemTypes && inheritedItemTypes) &&
    (effectiveItemTypes?.length ?? 0) === 0;
  const hasExistingItemConstraint =
    Array.isArray(items.enum) || Object.hasOwn(items, "const");
  const isCompatibleScalarEnum =
    !hasIncompatibleItemTypes &&
    nonNullEnum.length > 0 &&
    nonNullEnum.every((entry) =>
      isCompatibleScalarForItemTypes(entry, effectiveItemTypes),
    );

  if (isCompatibleScalarEnum && !hasExistingItemConstraint) {
    return {
      ...rest,
      items: {
        ...items,
        enum: nonNullEnum,
      },
    };
  }
  return rest;
}

function normalizeSchemaNode(
  value: unknown,
  inSchemaPosition: boolean,
  hasRefsInTree: boolean,
): { value: unknown; changed: boolean } {
  if (value === true && inSchemaPosition) {
    return { value: {}, changed: true };
  }
  if (Array.isArray(value)) {
    let anyChanged = false;
    const mapped = value.map((item) => {
      const res = normalizeSchemaNode(item, inSchemaPosition, hasRefsInTree);
      if (res.changed) {
        anyChanged = true;
      }
      return res.value;
    });
    return anyChanged
      ? { value: mapped, changed: true }
      : { value, changed: false };
  }
  if (!isPlainRecord(value)) {
    return { value, changed: false };
  }

  let current: Record<string, unknown> = value;
  let nodeChanged = false;

  // Relocate array-level `enum` before union distribution so array unions
  // still see their `type: "array"` prior to redistribution.
  const relocated = relocateArrayLevelEnum(current);
  if (relocated) {
    current = relocated;
    nodeChanged = true;
  }

  const distributed = distributeUnionSiblingKeywords(current, hasRefsInTree);
  if (distributed) {
    current = distributed;
    nodeChanged = true;
  }

  let childChanged = false;
  const entries = Object.entries(current).map(([key, item]) => {
    if (LITERAL_SCHEMA_FIELDS.has(key)) {
      return [key, item] as const;
    }
    if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(item)) {
      let mapChanged = false;
      const nextMap: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(item)) {
        const res = normalizeSchemaNode(
          propSchema,
          key !== "dependencies" || !Array.isArray(propSchema),
          hasRefsInTree,
        );
        if (res.changed) {
          mapChanged = true;
        }
        Object.defineProperty(nextMap, propName, {
          value: res.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      if (mapChanged) {
        childChanged = true;
        return [key, nextMap] as const;
      }
      return [key, item] as const;
    }
    const res = normalizeSchemaNode(
      item,
      BOOLEAN_SCHEMA_KEYWORDS.has(key) ||
        key === "anyOf" ||
        key === "oneOf" ||
        key === "allOf",
      hasRefsInTree,
    );
    if (res.changed) {
      childChanged = true;
    }
    return [key, res.value] as const;
  });

  if (!nodeChanged && !childChanged) {
    return { value, changed: false };
  }
  const nextObj: Record<string, unknown> = {};
  for (const [key, val] of entries) {
    Object.defineProperty(nextObj, key, {
      value: val,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { value: nextObj, changed: true };
}

/**
 * Normalize MCP tool parameter schemas for Copilot Gemini models, rewriting
 * only constructs that Copilot Gemini rejects with HTTP 400
 * `invalid_request_body`:
 *  1. Array-level `enum` -> `items.enum` (e.g. IcM MCP `search_incidents`).
 *  2. `anyOf` / `oneOf` nodes that also declare sibling `type`, `properties`,
 *     or `required` on the same node (e.g. WorkIQ MCP `retrieve`).
 *  3. Boolean schemas (`true` -> `{}`, e.g. ETW MCP `add_condition`).
 */
export function normalizeCopilotToolSchema(value: unknown): unknown {
  const hasRefsInTree = hasAnyLocalReference(value);
  return normalizeSchemaNode(value, false, hasRefsInTree).value;
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
    const hasRefsInTree = hasAnyLocalReference(tool.inputSchema);
    const { value, changed } = normalizeSchemaNode(
      tool.inputSchema,
      false,
      hasRefsInTree,
    );
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
