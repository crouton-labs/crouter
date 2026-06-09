// C3 regression fixture — a minimal extension that registers a CUSTOM model
// provider via pi.registerProvider. The services path (createAgentSessionServices)
// must register it into the ModelRegistry so the broker can resolve
// `c3prov/c3model`; plain createAgentSession never calls registerProvider, so the
// model would be missing (the C3 bug). No streamSimple/auth needed — these tests
// only assert registration + resolution, never run a turn.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI): void {
  pi.registerProvider('c3prov', {
    baseUrl: 'https://example.invalid',
    apiKey: 'c3-test-key',
    api: 'anthropic-messages',
    models: [
      {
        id: 'c3model',
        name: 'C3 Custom Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
    ],
  });
}
