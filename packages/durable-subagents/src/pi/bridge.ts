import { createModels, createAssistantMessageEventStream, fauxAssistantMessage, type Models, type Model, type Api } from '@durable-subagents/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

/** No auth store, provider import, token resolution or ambient inference in this bridge.
 * Pi's registry owns every request and its request-time auth. */
export function bridgeModels(registry: ExtensionContext['modelRegistry']): Models {
  if (typeof registry.streamSimple !== 'function' || typeof registry.find !== 'function')
    throw new Error('durable-subagents requires Pi >=0.99.2 with ModelRegistry.streamSimple (global Pi 0.85.1 is unsupported)');
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const selected = (model: Model<Api>) => {
    const found = registry.find(model.provider, model.id);
    if (!found || !registry.hasConfiguredAuth(found)) throw new Error('Selected model is no longer configured in the parent Pi registry');
    return found;
  };
  models.getModel = (provider, id) => {
    const found = registry.find(provider, id);
    return found && registry.hasConfiguredAuth(found) ? found as Model<Api> : undefined;
  };
  models.getModels = provider => registry.getAll().filter(m => !provider || m.provider === provider) as Model<Api>[];
  models.getAvailable = async provider => registry.getAvailable().filter(m => !provider || m.provider === provider) as Model<Api>[];
  // Each release has its own EventStream class with private fields. Forward DTO events
  // into the pinned native stream rather than casting one class into the other.
  const forward = (source: ReturnType<typeof registry.streamSimple>) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try { for await (const event of source) stream.push(event); stream.end(await source.result()); }
      catch { const message = fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Parent Pi provider stream failed' }); stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message); }
    })();
    return stream;
  };
  models.streamSimple = (model, context, options) => forward(registry.streamSimple(selected(model), context, options));
  models.completeSimple = (model, context, options) => models.streamSimple(model, context, options).result();
  // Durable normally uses streamSimple. Fail closed if a future path attempts an unsupported operation.
  models.stream = (model, context, options) => forward(registry.stream(selected(model), context, options));
  models.complete = (model, context, options) => models.stream(model, context, options).result();
  models.fetchDeferred = async () => { throw new Error('Deferred provider responses are unsupported by the stable Pi bridge'); };
  models.cancelDeferred = async () => { throw new Error('Deferred provider responses are unsupported by the stable Pi bridge'); };
  return models;
}
