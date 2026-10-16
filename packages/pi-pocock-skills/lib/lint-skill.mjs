import fs from "node:fs";
import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

const DEFAULT_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  entries: 10_000,
  documents: 2_000,
  edges: 50_000,
});

const LIMIT_KEYS = new Set(Object.keys(DEFAULT_LIMITS));
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__", ".pytest_cache"]);
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "compatibility",
  "metadata",
  "license",
  "allowed-tools",
  "disable-model-invocation",
]);

function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareNumbers(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function sortByPathThenLocation(a, b) {
  let result = compareStrings(a.path ?? "", b.path ?? "");
  if (result) return result;
  result = compareNumbers(a.line ?? 0, b.line ?? 0);
  if (result) return result;
  result = compareNumbers(a.column ?? 0, b.column ?? 0);
  if (result) return result;
  result = compareStrings(a.ruleId ?? "", b.ruleId ?? "");
  if (result) return result;
  return compareStrings(a.message ?? "", b.message ?? "");
}

function sortDependency(a, b) {
  let result = compareStrings(a.from, b.from);
  if (result) return result;
  result = compareStrings(a.target, b.target);
  if (result) return result;
  result = compareStrings(a.kind, b.kind);
  if (result) return result;
  return compareStrings(a.status, b.status);
}

function sortException(a, b) {
  let result = compareStrings(a.rule, b.rule);
  if (result) return result;
  return compareStrings(a.path, b.path);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isMarkdown(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return name.endsWith(".md") || name.endsWith(".markdown");
}

function isRegularFile(stat) {
  return stat?.isFile?.() === true;
}

function isDirectory(stat) {
  return stat?.isDirectory?.() === true;
}

function isSymlink(stat) {
  return stat?.isSymbolicLink?.() === true;
}

function normalizeSource(value) {
  let source = value.toString("utf8");
  if (source.startsWith("\ufeff")) source = source.slice(1);
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function sourceLineColumn(source, offset) {
  const bounded = Math.max(0, Math.min(offset ?? 0, source.length));
  const before = source.slice(0, bounded);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: 1 + (before.match(/\n/g)?.length ?? 0),
    column: bounded - lastNewline,
  };
}

function lineCountWithoutTerminalNewline(source) {
  if (source.length === 0) return 0;
  const lines = source.split("\n");
  return source.endsWith("\n") ? lines.length - 1 : lines.length;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function pathFromException(root, exceptionPath) {
  return path.resolve(root, exceptionPath);
}

function hasParentTraversal(value) {
  return value.split(/[\\/]+/u).some((part) => part === "..");
}

function scalarLength(value) {
  return [...value].length;
}

function addOptionalLocation(finding, line, column) {
  if (Number.isInteger(line)) finding.line = line;
  if (Number.isInteger(column)) finding.column = column;
}

function addFinding(state, finding) {
  const result = {
    ruleId: finding.ruleId,
    category: finding.category,
    severity: finding.severity,
    path: path.resolve(finding.path),
    message: finding.message,
  };
  addOptionalLocation(result, finding.line, finding.column);
  if (finding.route) {
    result.route = finding.route.map((item) =>
      typeof item === "string" && (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(item) || item.startsWith("//")) ? item : path.resolve(item));
  }
  if (Number.isInteger(finding.depth)) result.depth = finding.depth;
  if (Number.isInteger(finding.allowedDepth)) result.allowedDepth = finding.allowedDepth;
  state.findings.push(result);
}

function addOperational(state, ruleId, message, target = state.skill) {
  state.complete = false;
  addFinding(state, {
    ruleId,
    category: "operational",
    severity: "error",
    path: target,
    message,
  });
}

function parseLimits(state, supplied) {
  const limits = { ...DEFAULT_LIMITS };
  if (supplied === undefined) return limits;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    addOperational(state, "operational/limits", "options.limits must be an object.");
    return limits;
  }
  for (const key of Object.keys(supplied)) {
    if (!LIMIT_KEYS.has(key)) {
      addOperational(state, "operational/limits", `Unknown limit key: ${key}.`);
      continue;
    }
    const value = supplied[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      addOperational(state, "operational/limits", `Limit ${key} must be a positive safe integer.`);
      continue;
    }
    limits[key] = value;
  }
  return limits;
}

function parseExceptions(state, supplied) {
  if (supplied === undefined) return [];
  if (!Array.isArray(supplied)) {
    addOperational(state, "config/invalid-exception", "options.exceptions must be an array.");
    return [];
  }
  const result = [];
  const seen = new Set();
  for (const exception of supplied) {
    const validObject = exception && typeof exception === "object" && !Array.isArray(exception);
    if (!validObject) {
      addOperational(state, "config/invalid-exception", "Each exception must be an object.");
      continue;
    }
    const allowedKeys = exception.rule === "depth"
      ? new Set(["rule", "path", "maxDepth", "reason"])
      : new Set(["rule", "path", "reason"]);
    const unknown = Object.keys(exception).find((key) => !allowedKeys.has(key));
    const exceptionPath = exception.path;
    const reason = exception.reason;
    const rule = exception.rule;
    const pathValid = typeof exceptionPath === "string" && exceptionPath.length > 0 &&
      !path.isAbsolute(exceptionPath) && !hasParentTraversal(exceptionPath);
    const ruleValid = rule === "orphan" || rule === "depth";
    const reasonValid = typeof reason === "string" && reason.trim().length > 0;
    const depthValid = rule !== "depth" || (Number.isInteger(exception.maxDepth) && exception.maxDepth >= 3 && exception.maxDepth <= 100);
    if (unknown || !ruleValid || !pathValid || !reasonValid || !depthValid) {
      addOperational(state, "config/invalid-exception", "Exception must name a local orphan or depth rule, include a non-empty reason, and use a safe relative path.");
      continue;
    }
    const key = `${rule}\0${exceptionPath}`;
    if (seen.has(key)) {
      addOperational(state, "config/invalid-exception", `Duplicate exception for ${rule} ${exceptionPath}.`);
      continue;
    }
    seen.add(key);
    result.push({
      rule,
      path: exceptionPath,
      absolutePath: pathFromException(state.root, exceptionPath),
      reason,
      ...(rule === "depth" ? { maxDepth: exception.maxDepth } : {}),
      used: false,
    });
  }
  return result;
}

function yamlNodePosition(state, frontmatterStart, node) {
  const offset = node?.range?.[0];
  if (!Number.isInteger(offset)) return {};
  return sourceLineColumn(state.source, frontmatterStart + offset);
}

function yamlErrorPosition(state, frontmatterStart, error) {
  const offset = Array.isArray(error?.pos) ? error.pos[0] : undefined;
  return sourceLineColumn(state.source, frontmatterStart + (Number.isInteger(offset) ? offset : 0));
}

function walkYamlNode(node, callback) {
  if (!node) return;
  callback(node);
  if (isMap(node)) {
    for (const pair of node.items ?? []) {
      walkYamlNode(pair.key, callback);
      walkYamlNode(pair.value, callback);
    }
  } else if (isSeq(node)) {
    for (const item of node.items ?? []) walkYamlNode(item, callback);
  }
}

function mappingPairs(node) {
  return isMap(node) ? node.items ?? [] : [];
}

function fieldNode(rootNode, key) {
  return mappingPairs(rootNode).find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function addSchemaFinding(state, ruleId, message, node, severity = "error", category = "specification") {
  const location = yamlNodePosition(state, state.frontmatterStart, node?.key ?? node);
  addFinding(state, {
    ruleId,
    category,
    severity,
    path: state.skillFile,
    message,
    ...location,
  });
}

function parseFrontmatter(state, frontmatter) {
  let document;
  try {
    document = parseDocument(frontmatter, { uniqueKeys: true, version: "1.2" });
  } catch (error) {
    addSchemaFinding(state, "frontmatter/parse", `Frontmatter could not be parsed: ${errorMessage(error)}`);
    return { value: null, valid: false };
  }
  for (const error of document.errors ?? []) {
    const location = yamlErrorPosition(state, state.frontmatterStart, error);
    addFinding(state, {
      ruleId: "frontmatter/parse",
      category: "specification",
      severity: "error",
      path: state.skillFile,
      message: `Frontmatter could not be parsed: ${errorMessage(error)}`,
      ...location,
    });
  }
  if (document.errors?.length) return { value: null, valid: false };
  if (!isMap(document.contents)) {
    addSchemaFinding(state, "frontmatter/mapping", "Frontmatter must contain one YAML mapping.");
    return { value: null, valid: false };
  }

  let policyError = false;
  // The standard tag prefix is not a whitelist: !!unknown also resolves to it.
  // yaml reports unresolved tags as warnings; our authoring policy rejects them.
  for (const warning of document.warnings ?? []) {
    if (warning.code !== "TAG_RESOLVE_FAILED") continue;
    policyError = true;
    addFinding(state, {
      ruleId: "frontmatter/tag",
      category: "authoring",
      severity: "error",
      path: state.skillFile,
      message: "Custom or unresolved YAML tags are not allowed in skill frontmatter.",
      ...yamlErrorPosition(state, state.frontmatterStart, warning),
    });
  }
  walkYamlNode(document.contents, (node) => {
    if (isAlias(node)) {
      policyError = true;
      addSchemaFinding(state, "frontmatter/alias", "YAML aliases are not allowed in skill frontmatter.", node, "error", "authoring");
    }
  });
  for (const pair of mappingPairs(document.contents)) {
    if (isScalar(pair.key) && pair.key.value === "<<") {
      policyError = true;
      addSchemaFinding(state, "frontmatter/merge-key", "YAML merge keys are not allowed in skill frontmatter.", pair.key, "error", "authoring");
    }
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      addSchemaFinding(state, "frontmatter/key-type", "Frontmatter keys must be strings.", pair.key);
    }
  }
  if (policyError) return { value: null, valid: false };

  let value;
  try {
    value = document.toJS({ mapAsMap: false });
  } catch (error) {
    addSchemaFinding(state, "frontmatter/parse", `Frontmatter could not be converted: ${errorMessage(error)}`);
    return { value: null, valid: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    addSchemaFinding(state, "frontmatter/mapping", "Frontmatter must contain one YAML mapping.");
    return { value: null, valid: false };
  }
  return { value, valid: true, node: document.contents };
}

function checkStringField(state, rootNode, value, key, label, maximum, required = false) {
  const pair = fieldNode(rootNode, key);
  if (value === undefined) {
    if (required) addSchemaFinding(state, `frontmatter/${key}-required`, `${label} is required.`, rootNode);
    return false;
  }
  if (typeof value !== "string") {
    addSchemaFinding(state, `frontmatter/${key}-type`, `${label} must be a string.`, pair);
    return false;
  }
  if (required && value.trim().length === 0) {
    addSchemaFinding(state, `frontmatter/${key}-empty`, `${label} must not be empty or whitespace-only.`, pair);
  }
  const length = scalarLength(value);
  if (length > maximum) {
    addSchemaFinding(state, `frontmatter/${key}-length`, `${label} must be at most ${maximum} Unicode code points.`, pair);
  }
  if ((key === "name" || key === "description") && value.length > maximum && length <= maximum) {
    addSchemaFinding(state, "pi/utf16-length", `Pi counts ${label} using UTF-16 code units; its length limit would differ.`, pair, "warning", "pi");
  }
  return true;
}

function validateFrontmatter(state, parsed) {
  if (!parsed.valid) return false;
  const value = parsed.value;
  const rootNode = parsed.node;
  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) {
      addSchemaFinding(state, "frontmatter/unknown-field", `Unknown frontmatter field ${key}; put custom information under metadata.`, fieldNode(rootNode, key), "warning", "authoring");
    }
  }

  const nameIsString = checkStringField(state, rootNode, value.name, "name", "name", 64, true);
  if (nameIsString) {
    const nameNode = fieldNode(rootNode, "name");
    const name = value.name;
    if (!/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name) || name !== name.toLowerCase()) {
      addSchemaFinding(state, "frontmatter/name-shape", "name must use lowercase Unicode letters or numbers separated by single hyphens.", nameNode);
    }
    if (name !== path.basename(state.root)) {
      addSchemaFinding(state, "frontmatter/name-directory", `name must exactly match the skill directory name ${path.basename(state.root)}.`, nameNode);
    }
    if (/[^\x00-\x7F]/u.test(name)) {
      addSchemaFinding(state, "pi/name-ascii", "Pi's portable skill-name convention is ASCII-only; this Unicode name is valid under the Unicode policy but may not be portable.", nameNode, "warning", "pi");
    }
    state.name = name;
  }

  checkStringField(state, rootNode, value.description, "description", "description", 1024, true);
  if (value.compatibility !== undefined) {
    checkStringField(state, rootNode, value.compatibility, "compatibility", "compatibility", 500, false);
    if (typeof value.compatibility === "string" && value.compatibility.trim().length === 0) {
      addSchemaFinding(state, "frontmatter/compatibility-empty", "compatibility must not be whitespace-only.", fieldNode(rootNode, "compatibility"));
    }
  }

  if (value.metadata !== undefined) {
    const node = fieldNode(rootNode, "metadata");
    if (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata) || !isMap(node?.value)) {
      addSchemaFinding(state, "frontmatter/metadata-type", "metadata must be a mapping with string keys and string values.", node);
    } else {
      const invalidMetadata = (node.value.items ?? []).some((pair) =>
        !isScalar(pair.key) || typeof pair.key.value !== "string" ||
        !isScalar(pair.value) || typeof pair.value.value !== "string");
      if (invalidMetadata) {
        addSchemaFinding(state, "frontmatter/metadata-type", "metadata must be a mapping with string keys and string values.", node);
      }
    }
  }

  for (const key of ["license", "allowed-tools"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      addSchemaFinding(state, `frontmatter/${key}-type`, `${key} must be a string.`, fieldNode(rootNode, key));
    }
  }
  if (value["allowed-tools"] !== undefined && typeof value["allowed-tools"] === "string") {
    addSchemaFinding(state, "pi/allowed-tools", "Pi does not enforce allowed-tools as a permission declaration.", fieldNode(rootNode, "allowed-tools"), "warning", "pi");
  }
  if (value["disable-model-invocation"] !== undefined && typeof value["disable-model-invocation"] !== "boolean") {
    addSchemaFinding(state, "pi/disable-model-invocation-type", "disable-model-invocation must be the YAML boolean true or false, not a quoted string.", fieldNode(rootNode, "disable-model-invocation"), "error", "pi");
  }
  return true;
}

function splitFrontmatter(state, source) {
  const lines = source.split("\n");
  if (lines[0] !== "---") {
    addFinding(state, {
      ruleId: "frontmatter/opening",
      category: "specification",
      severity: "error",
      path: state.skillFile,
      line: 1,
      column: 1,
      message: "SKILL.md must begin with a standalone --- frontmatter delimiter.",
    });
    return null;
  }
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      closing = index;
      break;
    }
  }
  if (closing < 0) {
    addFinding(state, {
      ruleId: "frontmatter/closing",
      category: "specification",
      severity: "error",
      path: state.skillFile,
      line: 1,
      column: 1,
      message: "SKILL.md frontmatter must have a standalone closing --- delimiter.",
    });
    return null;
  }
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  const frontmatterStart = lineOffsets[1] ?? source.length;
  const bodyStart = lineOffsets[closing + 1] ?? source.length;
  state.frontmatterStart = frontmatterStart;
  state.bodyStartLine = closing + 2;
  return {
    frontmatter: lines.slice(1, closing).join("\n"),
    body: source.slice(bodyStart),
    bodyStart,
  };
}

function collectDefinitions(tree) {
  const definitions = new Map();
  const visit = (node) => {
    if (!node || node.type === "code" || node.type === "inlineCode" || node.type === "html") return;
    if (node.type === "definition" && typeof node.identifier === "string" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return definitions;
}

function extractLinks(body) {
  const tree = fromMarkdown(body);
  const definitions = collectDefinitions(tree);
  const links = [];
  const visit = (node) => {
    if (!node || node.type === "code" || node.type === "inlineCode" || node.type === "html" || node.type === "definition") return;
    if (["link", "image"].includes(node.type) && typeof node.url === "string") {
      links.push({ url: node.url, position: node.position?.start });
    } else if (["linkReference", "imageReference"].includes(node.type) && typeof node.identifier === "string") {
      const url = definitions.get(node.identifier);
      if (typeof url === "string") links.push({ url, position: node.position?.start });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return links;
}

function parseMarkdown(state, filePath, bytes, isRoot) {
  const canonical = state.canonicalPath(filePath);
  if (!canonical) {
    if (!isRoot) return null;
    let resolved;
    try {
      resolved = fs.realpathSync(filePath);
    } catch (error) {
      addOperational(state, "operational/read", `Could not resolve ${filePath}: ${errorMessage(error)}`, filePath);
      return null;
    }
    addOperational(state, "operational/scope", `Resource resolves outside the configured resource root: ${resolved}.`, filePath);
    return null;
  }
  if (state.parsedCache.has(canonical)) return state.parsedCache.get(canonical);
  if (state.blockedFiles.has(canonical)) return null;
  const stat = state.fileStat(filePath, true);
  if (!stat) return null;
  if (!isRegularFile(stat)) {
    addOperational(state, "operational/unsupported-resource", "Only regular files may be parsed; this resource has an unsupported type.", filePath);
    state.blockedFiles.add(canonical);
    return null;
  }
  const size = stat.size;
  if (size > state.limits.fileBytes) {
    addOperational(state, "operational/file-bytes", `Parsed file exceeds the ${state.limits.fileBytes}-byte limit.`, filePath);
    state.blockedFiles.add(canonical);
    return null;
  }
  if (state.totalBytes + size > state.limits.totalBytes) {
    addOperational(state, "operational/total-bytes", `Parsed resources exceed the ${state.limits.totalBytes}-byte total limit.`, filePath);
    state.blockedFiles.add(canonical);
    return null;
  }
  if (state.parsedDocuments >= state.limits.documents) {
    addOperational(state, "operational/documents", `Parsed documents exceed the ${state.limits.documents}-document limit.`, filePath);
    state.blockedFiles.add(canonical);
    return null;
  }
  let source;
  try {
    source = normalizeSource(fs.readFileSync(filePath));
  } catch (error) {
    addOperational(state, "operational/read", `Could not read ${filePath}: ${errorMessage(error)}`, filePath);
    state.blockedFiles.add(canonical);
    return null;
  }
  state.totalBytes += size;
  state.parsedDocuments += 1;
  const result = {
    markdownOk: true,
    frontmatterOk: true,
    links: [],
    body: "",
  };
  if (isRoot) {
    state.source = source;
    const split = splitFrontmatter(state, source);
    if (!split) {
      result.frontmatterOk = false;
      result.markdownOk = false;
    } else {
      const parsed = parseFrontmatter(state, split.frontmatter);
      result.frontmatterOk = parsed.valid;
      if (parsed.valid) validateFrontmatter(state, parsed);
      result.body = split.body;
      state.body = split.body;
      const count = lineCountWithoutTerminalNewline(source);
      if (split.body.trim().length === 0) {
        addFinding(state, {
          ruleId: "authoring/empty-body",
          category: "authoring",
          severity: "warning",
          path: state.skillFile,
          line: state.bodyStartLine,
          column: 1,
          message: "SKILL.md has an empty instruction body.",
        });
      }
      if (count >= 500) {
        addFinding(state, {
          ruleId: "authoring/line-count",
          category: "authoring",
          severity: "warning",
          path: state.skillFile,
          line: 1,
          column: 1,
          message: "SKILL.md contains 500 or more lines.",
        });
      }
    }
  } else {
    result.body = source;
  }
  try {
    result.links = extractLinks(result.body);
  } catch (error) {
    result.markdownOk = false;
    result.links = [];
    addFinding(state, {
      ruleId: "markdown/parse",
      category: "specification",
      severity: "error",
      path: filePath,
      message: `Markdown could not be parsed: ${errorMessage(error)}`,
    });
  }
  state.parsedCache.set(canonical, result);
  return result;
}

function parseDestination(rawDestination) {
  const raw = String(rawDestination);
  if (raw === "" || raw.startsWith("#")) return { fragmentOnly: true };
  if (raw.startsWith("//")) return { url: true, target: raw };
  const scheme = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):/u);
  if (scheme && scheme[1].toLowerCase() !== "file") return { url: true, target: raw };
  if (scheme && scheme[1].toLowerCase() === "file") {
    try {
      const parsed = new URL(raw);
      if (parsed.hostname && parsed.hostname !== "localhost") return { local: true, absolute: true, path: `//${parsed.hostname}${decodeURIComponent(parsed.pathname)}` };
      return { local: true, absolute: true, path: decodeURIComponent(parsed.pathname) };
    } catch (error) {
      return { invalidEncoding: true, error: errorMessage(error) };
    }
  }
  const separator = raw.search(/[?#]/u);
  const pathPart = separator < 0 ? raw : raw.slice(0, separator);
  if (pathPart === "") return { fragmentOnly: true };
  try {
    const decodedPath = decodeURIComponent(pathPart);
    return { local: true, absolute: path.isAbsolute(decodedPath), path: decodedPath };
  } catch (error) {
    return { invalidEncoding: true, error: errorMessage(error) };
  }
}

function classifyTarget(state, candidate) {
  const lexicalInScope = isWithin(state.scopeLexical, candidate);
  if (!lexicalInScope) {
    return { kind: "external", status: "unverified", candidate, inSkill: false, inScope: false };
  }
  let lstat;
  try {
    lstat = fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { kind: "external", status: "missing", candidate, missing: true, inSkill: isWithin(state.root, candidate), inScope: true };
    }
    addOperational(state, "operational/stat", `Could not inspect ${candidate}: ${errorMessage(error)}`, candidate);
    return { kind: "external", status: "unverified", candidate, inaccessible: true, inScope: true };
  }
  let stat = lstat;
  let canonical = candidate;
  if (isSymlink(lstat)) {
    try {
      canonical = fs.realpathSync(candidate);
      if (!isWithin(state.scopeReal, canonical)) {
        return { kind: "external", status: "unverified", candidate, canonical, inSkill: isWithin(state.root, candidate), inScope: false, outside: true };
      }
      stat = fs.statSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return { kind: "external", status: "missing", candidate, missing: true, inSkill: isWithin(state.root, candidate), inScope: true, brokenSymlink: true };
      }
      addOperational(state, "operational/stat", `Could not inspect ${candidate}: ${errorMessage(error)}`, candidate);
      return { kind: "external", status: "unverified", candidate, inaccessible: true, inScope: true };
    }
  } else {
    try {
      canonical = fs.realpathSync(candidate);
      if (!isWithin(state.scopeReal, canonical)) {
        return { kind: "external", status: "unverified", candidate, canonical, inSkill: isWithin(state.root, candidate), inScope: false, outside: true };
      }
    } catch (error) {
      addOperational(state, "operational/stat", `Could not resolve ${candidate}: ${errorMessage(error)}`, candidate);
      return { kind: "external", status: "unverified", candidate, inaccessible: true, inScope: true };
    }
  }
  const inSkill = isWithin(state.root, candidate);
  if (isDirectory(stat)) {
    return { kind: isSymlink(lstat) ? "symlink-directory" : "directory", status: "exists", candidate, canonical, inSkill, inScope: true, directory: true };
  }
  if (isRegularFile(stat)) {
    const otherSkill = path.basename(candidate) === "SKILL.md" && (
      !isWithin(state.root, path.dirname(candidate)) ||
      (path.basename(canonical) === "SKILL.md" && !isWithin(state.rootReal, path.dirname(canonical)))
    );
    return { kind: otherSkill ? "skill" : "external", status: "exists", candidate, canonical, inSkill, inScope: true, file: true, otherSkill };
  }
  return { kind: "external", status: "unverified", candidate, canonical, inSkill, inScope: true, unsupported: true };
}

function addDependency(state, from, target, kind, status) {
  state.dependencies.push({ from: path.resolve(from), target, kind, status });
}

function linkLocation(state, documentPath, position) {
  if (!position || !Number.isInteger(position.line)) return {};
  return {
    line: state.documentBodyStart.get(documentPath) + position.line - 1,
    column: position.column,
  };
}

function routeCandidate(state, info) {
  return info.file && info.inScope && info.inSkill && !info.otherSkill && info.candidate;
}

function recordExternalRoute(state, key, target, route, from) {
  if (!state.externalRoutes.has(key)) {
    state.externalRoutes.set(key, { target, route: [...route, target], from });
  }
}

function processLink(state, documentPath, link, route, allowRoutes) {
  if (state.edgeCount >= state.limits.edges) {
    addOperational(state, "operational/edges", `Extracted links exceed the ${state.limits.edges}-edge limit.`, documentPath);
    return null;
  }
  state.edgeCount += 1;
  const destination = parseDestination(link.url);
  const location = linkLocation(state, documentPath, link.position);
  if (destination.fragmentOnly) return null;
  if (destination.invalidEncoding) {
    addFinding(state, {
      ruleId: "references/invalid-encoding",
      category: "authoring",
      severity: "error",
      path: documentPath,
      message: `Link destination is not valid percent-encoding: ${destination.error}`,
      ...location,
    });
    return null;
  }
  if (destination.url) {
    addDependency(state, documentPath, destination.target, "url", "unverified");
    if (allowRoutes) recordExternalRoute(state, `url:${destination.target}`, destination.target, route, documentPath);
    return null;
  }
  const candidate = destination.absolute ? path.resolve(destination.path) : path.resolve(state.root, destination.path);
  if (destination.absolute || /^file:/iu.test(link.url)) {
    addFinding(state, {
      ruleId: "references/nonportable",
      category: "authoring",
      severity: "warning",
      path: documentPath,
      message: "Absolute and file-URI references are not portable between skill installations.",
      ...location,
    });
  }
  const info = classifyTarget(state, candidate);
  const recordsDependency = !info.inSkill || !info.inScope || info.directory || info.otherSkill;
  if (recordsDependency) {
    addDependency(state, documentPath, candidate, info.kind, info.status === "missing" ? "unverified" : info.status);
  }
  if (allowRoutes && !info.otherSkill && !info.missing && !info.unsupported && (!info.inSkill || !info.inScope || info.outside)) {
    recordExternalRoute(state, info.canonical ?? info.candidate, info.candidate, route, documentPath);
  }
  if (info.missing) {
    addFinding(state, {
      ruleId: "references/missing",
      category: "authoring",
      severity: "error",
      path: documentPath,
      message: `Referenced resource does not exist: ${candidate}.`,
      ...location,
    });
    return null;
  }
  if (info.inaccessible) return null;
  // Scope is a traversal permission, not a ban on declaring external resources.
  // Their status is explicit in dependencies; only excessive depth warns.
  if (!info.inScope || info.outside) return null;
  if (info.unsupported) {
    addOperational(state, "operational/unsupported-resource", `Referenced resource is not a regular file or directory: ${candidate}.`, candidate);
    return null;
  }
  if (info.directory) {
    addFinding(state, {
      ruleId: info.kind === "symlink-directory" ? "references/symlink-directory" : "references/directory",
      category: "authoring",
      severity: "warning",
      path: documentPath,
      message: "Directory links do not make directory contents reachable; link each resource explicitly.",
      ...location,
    });
    return null;
  }
  if (allowRoutes && routeCandidate(state, info)) {
    const target = info.candidate;
    if (!state.routes.has(target)) {
      const nextRoute = [...route, target];
      state.routes.set(target, nextRoute);
      if (isMarkdown(target)) state.queue.push({ path: target, route: nextRoute, root: false });
    }
  }
  if (allowRoutes && info.file && info.inScope && !info.inSkill && !info.otherSkill && isMarkdown(info.candidate)) {
    const key = info.canonical ?? info.candidate;
    if (!state.externalRoutes.has(key)) recordExternalRoute(state, key, info.candidate, route, documentPath);
    if (!state.queuedExternal.has(key)) {
      state.queuedExternal.add(key);
      const nextRoute = state.externalRoutes.get(key).route;
      state.queue.push({ path: info.candidate, route: nextRoute, root: false, external: true });
    }
  }
  return info;
}

function processDocument(state, documentPath, route, allowRoutes, isRoot = false) {
  const parsed = parseMarkdown(state, documentPath, undefined, isRoot);
  if (!parsed || !parsed.markdownOk) return false;
  if (isRoot && !parsed.frontmatterOk) return false;
  state.documentBodyStart.set(documentPath, isRoot ? state.bodyStartLine : 1);
  if (state.processedDocuments.has(documentPath)) return true;
  state.processedDocuments.add(documentPath);
  for (const link of parsed.links) processLink(state, documentPath, link, route, allowRoutes);
  return true;
}

function parseMarkdownInventory(state) {
  const resources = [...state.inventory.values()].sort((a, b) => compareStrings(a.path, b.path));
  for (const resource of resources) {
    if (!isMarkdown(resource.path) || resource.path === state.skillFile || state.processedDocuments.has(resource.path)) continue;
    processDocument(state, resource.path, [], false, false);
  }
}

function analyzeExternalDepths(state) {
  const routes = [...state.externalRoutes.values()].sort((a, b) => compareStrings(a.target, b.target));
  for (const external of routes) {
    const depth = external.route.length - 1;
    if (depth < 3) continue;
    const targetIsUrl = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(external.target) || external.target.startsWith("//");
    addFinding(state, {
      ruleId: "resources/depth",
      category: "authoring",
      severity: "warning",
      path: targetIsUrl ? external.from : external.target,
      message: `External resource is ${depth} links from SKILL.md; the allowed depth is 2.`,
      route: external.route,
      depth,
      allowedDepth: 2,
    });
  }
}

function analyzeGraph(state, rootParsed) {
  state.routes.set(state.skillFile, [state.skillFile]);
  state.documentBodyStart.set(state.skillFile, state.bodyStartLine);
  if (rootParsed) {
    state.queue.push({ path: state.skillFile, route: [state.skillFile], root: true });
    while (state.queue.length) {
      const current = state.queue.shift();
      if (current.root) {
        processDocument(state, current.path, current.route, true, true);
      } else {
        processDocument(state, current.path, current.route, true, false);
      }
    }
  }
  parseMarkdownInventory(state);
}

function inventory(state) {
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      addOperational(state, "operational/inventory", `Could not inventory ${directory}: ${errorMessage(error)}`, directory);
      return;
    }
    entries.sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      let lstat;
      try {
        lstat = fs.lstatSync(entryPath);
      } catch (error) {
        addOperational(state, "operational/inventory", `Could not inspect ${entryPath}: ${errorMessage(error)}`, entryPath);
        continue;
      }
      let targetStat = lstat;
      if (isSymlink(lstat)) {
        try {
          targetStat = fs.statSync(entryPath);
        } catch {
          targetStat = null;
        }
      }
      if (state.entryCount >= state.limits.entries) {
        addOperational(state, "operational/entries", `Inventoried entries exceed the ${state.limits.entries}-entry limit.`, entryPath);
        return;
      }
      state.entryCount += 1;
      if (EXCLUDED_DIRECTORIES.has(entry.name) && (isDirectory(targetStat) || (isSymlink(lstat) && isDirectory(targetStat)))) continue;
      if (isDirectory(lstat)) {
        visit(entryPath);
      } else if (isRegularFile(lstat) || (isSymlink(lstat) && isRegularFile(targetStat))) {
        state.inventory.set(entryPath, { path: entryPath, kind: "file", canonical: state.canonicalPath(entryPath) });
      } else if (isSymlink(lstat) && isDirectory(targetStat)) {
        state.inventory.set(entryPath, { path: entryPath, kind: "symlink-directory", canonical: state.canonicalPath(entryPath) });
        addFinding(state, {
          ruleId: "resources/symlink-directory",
          category: "authoring",
          severity: "warning",
          path: entryPath,
          message: "Symlinked directories are not recursively inventoried or expanded; link individual resources explicitly.",
        });
      } else if (!isSymlink(lstat) && targetStat && !isDirectory(targetStat) && !isRegularFile(targetStat)) {
        addOperational(state, "operational/unsupported-resource", `Unsupported special resource was found: ${entryPath}.`, entryPath);
        state.inventory.set(entryPath, { path: entryPath, kind: "special" });
      } else if (isSymlink(lstat)) {
        state.inventory.set(entryPath, { path: entryPath, kind: "symlink", canonical: state.canonicalPath(entryPath) });
      }
    }
  };
  visit(state.root);
}

function validateRoot(state) {
  let stat;
  try {
    stat = fs.statSync(state.root);
  } catch (error) {
    addOperational(state, "operational/root", `Skill directory could not be opened: ${errorMessage(error)}`, state.root);
    return false;
  }
  if (!isDirectory(stat)) {
    addOperational(state, "operational/root", "The supplied skill path is not a directory.", state.root);
    return false;
  }
  try {
    state.rootReal = fs.realpathSync(state.root);
  } catch (error) {
    addOperational(state, "operational/root", `Skill directory could not be resolved: ${errorMessage(error)}`, state.root);
    return false;
  }
  return true;
}

function validateScope(state, resourceRoot) {
  state.scopeLexical = resourceRoot ? path.resolve(resourceRoot) : state.root;
  try {
    const stat = fs.statSync(state.scopeLexical);
    if (!isDirectory(stat)) throw new Error("resourceRoot is not a directory");
    state.scopeReal = fs.realpathSync(state.scopeLexical);
  } catch (error) {
    addOperational(state, "operational/resource-root", `Resource root could not be opened: ${errorMessage(error)}`, state.scopeLexical);
    return false;
  }
  if (!isWithin(state.scopeLexical, state.root) || !isWithin(state.scopeReal, state.rootReal)) {
    addOperational(state, "operational/resource-root", "resourceRoot must contain the supplied skill directory in both lexical and resolved paths.", state.scopeLexical);
    return false;
  }
  return true;
}

function finalize(state) {
  state.findings.sort(sortByPathThenLocation);
  state.dependencies.sort(sortDependency);
  state.appliedExceptions.sort(sortException);
  return {
    schemaVersion: 1,
    skill: state.skill,
    name: state.name,
    complete: state.complete,
    findings: state.findings,
    dependencies: state.dependencies,
    appliedExceptions: state.appliedExceptions,
  };
}

export function lintSkill(directory, options = {}) {
  const validDirectory = typeof directory === "string" && directory.length > 0;
  const validOptions = options !== null && typeof options === "object" && !Array.isArray(options);
  const skill = validDirectory ? path.resolve(directory) : path.resolve(path.sep, "lint-skill-invalid-input");
  const state = {
    skill,
    root: skill,
    skillFile: path.join(skill, "SKILL.md"),
    name: null,
    complete: true,
    findings: [],
    dependencies: [],
    appliedExceptions: [],
    parsedCache: new Map(),
    blockedFiles: new Set(),
    inventory: new Map(),
    routes: new Map(),
    externalRoutes: new Map(),
    queuedExternal: new Set(),
    processedDocuments: new Set(),
    documentBodyStart: new Map(),
    queue: [],
    limits: null,
    entryCount: 0,
    parsedDocuments: 0,
    totalBytes: 0,
    edgeCount: 0,
    source: "",
    body: "",
    frontmatterStart: 0,
    bodyStartLine: 1,
    rootReal: null,
    scopeLexical: skill,
    scopeReal: null,
    canonicalPath(filePath) {
      try {
        const real = fs.realpathSync(filePath);
        return isWithin(this.scopeReal ?? this.scopeLexical, real) ? real : null;
      } catch {
        return null;
      }
    },
    fileStat(filePath, followSymlink) {
      try {
        return followSymlink ? fs.statSync(filePath) : fs.lstatSync(filePath);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
        addOperational(this, "operational/stat", `Could not inspect ${filePath}: ${errorMessage(error)}`, filePath);
        return null;
      }
    },
  };

  if (!validDirectory || !validOptions) {
    addOperational(state, "operational/arguments", "lintSkill requires a non-empty directory string and an options object.");
    return finalize(state);
  }
  state.limits = parseLimits(state, options.limits);
  if (options.resourceRoot !== undefined && (typeof options.resourceRoot !== "string" || options.resourceRoot.length === 0)) {
    addOperational(state, "operational/arguments", "options.resourceRoot must be a non-empty directory string.");
    return finalize(state);
  }
  const rootValid = validateRoot(state);
  if (!rootValid) return finalize(state);
  const scopeValid = validateScope(state, options.resourceRoot);
  if (!scopeValid) return finalize(state);
  state.exceptions = parseExceptions(state, options.exceptions);

  inventory(state);
  const rootStat = state.fileStat(state.skillFile, true);
  let rootParsed = false;
  if (!rootStat) {
    addFinding(state, {
      ruleId: "resources/missing-skill",
      category: "specification",
      severity: "error",
      path: state.skillFile,
      line: 1,
      column: 1,
      message: "Skill directory must contain an exact-name SKILL.md file.",
    });
  } else if (!isRegularFile(rootStat)) {
    addOperational(state, "operational/unsupported-resource", "SKILL.md must be a regular file.", state.skillFile);
  } else {
    const parsed = parseMarkdown(state, state.skillFile, rootStat.size, true);
    rootParsed = Boolean(parsed?.markdownOk && parsed.frontmatterOk);
  }
  analyzeGraph(state, rootParsed);

  if (rootParsed) {
    analyzeExternalDepths(state);
  }

  if (rootParsed) {
    const resources = [...state.inventory.values()].sort((a, b) => compareStrings(a.path, b.path));
    for (const resource of resources) {
      if (resource.path === state.skillFile) continue;
      const route = state.routes.get(resource.path);
      const exception = state.exceptions.find((item) => item.absolutePath === resource.path && item.rule === "orphan");
      if (!route) {
        if (exception) {
          exception.used = true;
          state.appliedExceptions.push({ rule: exception.rule, path: exception.path, reason: exception.reason });
        } else {
          addFinding(state, {
            ruleId: "resources/orphan",
            category: "authoring",
            severity: "warning",
            path: resource.path,
            message: `Resource is not reachable from SKILL.md by an explicit Markdown link: ${resource.path}.`,
          });
        }
        continue;
      }
      const depth = route.length - 1;
      if (depth < 3) continue;
      const depthException = state.exceptions.find((item) => item.absolutePath === resource.path && item.rule === "depth");
      const allowedDepth = depthException?.maxDepth ?? 2;
      if (depthException) {
        depthException.used = true;
        state.appliedExceptions.push({ rule: depthException.rule, path: depthException.path, maxDepth: depthException.maxDepth, reason: depthException.reason });
      }
      if (depth > allowedDepth) {
        addFinding(state, {
          ruleId: "resources/depth",
          category: "authoring",
          severity: "warning",
          path: resource.path,
          message: `Resource is ${depth} links from SKILL.md; the allowed depth is ${allowedDepth}.`,
          route,
          depth,
          allowedDepth,
        });
      }
    }
    for (const exception of state.exceptions) {
      if (!exception.used) {
        addFinding(state, {
          ruleId: "config/stale",
          category: "authoring",
          severity: "warning",
          path: exception.absolutePath,
          message: `Exception ${exception.rule} ${exception.path} is stale: it does not suppress a current finding.`,
        });
      }
    }
  }
  return finalize(state);
}
