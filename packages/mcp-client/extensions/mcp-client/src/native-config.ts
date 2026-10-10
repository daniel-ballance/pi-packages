/**
 * Read-only native Pi configuration adapter (Pi 1.1.0 semantics).
 *
 * The caller supplies ONLY trusted paths, in increasing precedence. Registrations
 * are the lowest-priority layer. Complete definitions replace earlier ones;
 * transportless entries may change only enabled/exposure/toolExposure, retaining
 * connection details. An explicit toolExposure map replaces the old map, just as
 * in native Pi; omitting it retains every restriction and its pattern order.
 * Exposure selection (exact name, then first glob, then server default) belongs
 * to the host adapter, not this module. Never treat deferred loading as hiding.
 *
 * Recognized package extension fields: protocol selects the wire protocol;
 * toolLoading retains the package loading hint but NEVER changes exposure, whose
 * native default remains codemode. Runtime serverOptions are a per-server map of
 * the narrow capability/wire options below, not a second access-policy source.
 * Options for absent servers are validated but do not create a server.
 *
 * Deliberate limits: whole-load failure instead of native's skip-invalid behavior;
 * no automatic discovery of paths, shell-valued credentials, provider auth,
 * native credential-store import, or automatic OAuth on 401. Explicit OAuth only
 * supports the package's public-client subset and uses its separate token store.
 * autoEnableCodemode is unsupported (rejected, not silently discarded). Timeouts
 * become integer milliseconds within the package's range; hard deadlines do not
 * acquire native's progress-reset behavior. No files are modified or servers run.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ExposureSchema, LEGACY, MODERN, ServerSchema, type ServerConfig } from './config.js';
import { DiagnosticError, displayText } from './diagnostics.js';

export interface NativeRegistration {
  name: string;
  config: unknown;
  extensionPath?: string;
}

const ProtocolSchema = z.enum(['auto', MODERN, ...LEGACY]);
/** These options cannot enable a disabled server or replace its exposure policy. */
export const NativeServerOptionsSchema = z
  .object({
    protocol: ProtocolSchema.optional(),
    elicitation: z.boolean().optional(),
    elicitationUrl: z.boolean().optional(),
    roots: z.array(z.string()).optional(),
    sampling: z.boolean().optional(),
    samplingTools: z.boolean().optional(),
    tasks: z.boolean().optional(),
  })
  .strict();
export type NativeServerOptions = z.infer<typeof NativeServerOptionsSchema>;

const NativeExposureSchema = z
  .union([ExposureSchema, z.literal('codemode-deferred')])
  .transform((value) => (value === 'codemode-deferred' ? 'codemode' : value));
const policy = {
  enabled: z.boolean().optional(),
  exposure: NativeExposureSchema.optional(),
  toolExposure: z.record(z.string(), NativeExposureSchema).optional(),
};
const OverrideSchema = z.object(policy).strict();
const common = {
  ...policy,
  description: z.string().optional(),
  timeout: z.number().positive().optional(),
  protocol: ProtocolSchema.optional(),
  toolLoading: z.enum(['eager', 'deferred']).optional(),
};
// Native !command resolution is intentionally never evaluated, even for disabled
// entries. Refuse it instead of passing the literal as a different credential.
const LiteralValueSchema = z.string().refine((value) => !value.trimStart().startsWith('!'));
const StdioSchema = z
  .object({
    ...common,
    type: z.literal('stdio').optional(),
    command: LiteralValueSchema.pipe(z.string().min(1)),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), LiteralValueSchema).optional(),
    cwd: z.string().optional(),
  })
  .strict();
const HttpSchema = z
  .object({
    ...common,
    type: z.enum(['http', 'streamable-http']).optional(),
    url: z.string().min(1),
    headers: z.record(z.string(), LiteralValueSchema).optional(),
    oauth: z
      .object({
        clientId: z.string().min(1).optional(),
        callbackPort: z.number().int().min(1024).max(65535).optional(),
        scope: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const NameSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const FileSchema = z.object({ mcpServers: z.record(NameSchema, z.unknown()).default({}) }).strict();

function invalid(source: string, reason: string): never {
  throw new DiagnosticError(
    `Invalid native MCP configuration in ${displayText(source)}: ${reason}. Check these fields and /reload`,
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// Zod deliberately drops __proto__ record keys. Reject rather than silently
// dropping a server, credential, or hidden-tool rule. Values are never logged.
function rejectReservedKeys(value: unknown, source: string): void {
  if (isRecord(value)) {
    if (Object.hasOwn(value, '__proto__')) invalid(source, 'reserved object key');
    for (const child of Object.values(value)) rejectReservedKeys(child, source);
  } else if (Array.isArray(value)) {
    for (const child of value) rejectReservedKeys(child, source);
  }
}
function checked<T>(schema: z.ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // No Zod messages/received values: these can contain credentials.
  const issues = result.error.issues
    .slice(0, 5)
    .map((issue) => `${displayText(issue.path.join('.') || '(root)', 160)}: ${issue.code}`);
  return invalid(source, issues.join('; '));
}
function normalize(value: unknown, source: string): ServerConfig {
  const parsed =
    isRecord(value) && value.url !== undefined
      ? checked(HttpSchema, value, source)
      : checked(StdioSchema, value, source);
  const { type: _type, enabled, timeout, ...fields } = parsed;
  const milliseconds = (timeout ?? 60) * 1000;
  // Correct only floating-point multiplication noise (e.g. 1.001 seconds).
  // Genuine sub-millisecond values still fail the integer runtime schema.
  const rounded = Math.round(milliseconds);
  const exactMilliseconds =
    Math.abs(milliseconds - rounded) <= Number.EPSILON * Math.abs(milliseconds)
      ? rounded
      : milliseconds;
  const normalized: Record<string, unknown> = {
    ...fields,
    native: true,
    disabled: enabled === false,
    exposure: parsed.exposure ?? 'codemode',
    timeout: exactMilliseconds,
    transport: 'url' in parsed ? 'http' : 'stdio',
  };
  if ('oauth' in parsed && parsed.oauth !== undefined) {
    const { callbackPort, ...oauth } = parsed.oauth;
    normalized.oauth = { ...oauth, redirectPort: callbackPort };
  }
  return checked(ServerSchema, normalized, source);
}

/**
 * Load trusted native files plus extension registrations. Nothing is resolved or
 * executed here; use resolveConfig at connection time for environment/home paths.
 * All supplied layers (even disabled/shadowed entries) must validate. Later files
 * override registrations and earlier files by exact name; distinct names that
 * normalize to the same native namespace are rejected, including disabled ones.
 */
export async function loadNativeConfig(
  paths: string[],
  registrations: NativeRegistration[] = [],
  serverOptions: Record<string, unknown> = {},
): Promise<Record<string, ServerConfig>> {
  rejectReservedKeys(serverOptions, 'serverOptions');
  const options = checked(
    z.record(NameSchema, NativeServerOptionsSchema),
    serverOptions,
    'serverOptions',
  );
  const servers: Record<string, ServerConfig> = Object.create(null);
  const namespaces = new Map<string, string>();
  const add = (name: string, value: unknown, source: string, allowOverride: boolean) => {
    checked(NameSchema, name, source);
    rejectReservedKeys(value, source);
    const namespace = name.replace(/-/g, '_');
    const prior = namespaces.get(namespace);
    if (prior !== undefined && prior !== name) invalid(source, 'normalized namespace collision');
    if (
      allowOverride &&
      isRecord(value) &&
      value.command === undefined &&
      value.url === undefined &&
      value.type === undefined
    ) {
      const patch = checked(OverrideSchema, value, source);
      const base = servers[name];
      if (!base) invalid(source, 'transportless override requires an existing server');
      servers[name] = checked(
        ServerSchema,
        {
          ...base,
          ...(patch.enabled === undefined ? {} : { disabled: !patch.enabled }),
          ...(patch.exposure === undefined ? {} : { exposure: patch.exposure }),
          ...(patch.toolExposure === undefined ? {} : { toolExposure: patch.toolExposure }),
        },
        source,
      );
    } else {
      servers[name] = normalize(value, source);
    }
    namespaces.set(namespace, name);
  };
  for (const { name, config, extensionPath } of registrations) {
    add(name, config, `registration ${name}${extensionPath ? ` (${extensionPath})` : ''}`, false);
  }
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new DiagnosticError(
        `Cannot read native MCP configuration ${displayText(path)}; check file permissions`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new DiagnosticError(`Invalid JSON in ${displayText(path)}; fix syntax and /reload`);
    }
    rejectReservedKeys(value, path);
    const file = checked(FileSchema, value, path);
    for (const [name, config] of Object.entries(file.mcpServers)) {
      add(name, config, `${path} mcpServers.${name}`, true);
    }
  }
  for (const [name, config] of Object.entries(servers)) {
    // Undefined options are not explicit overrides and must not restore defaults.
    const overrides = Object.fromEntries(
      Object.entries(options[name] ?? {}).filter(([, value]) => value !== undefined),
    );
    servers[name] = checked(ServerSchema, { ...config, ...overrides }, `serverOptions.${name}`);
  }
  return servers;
}
