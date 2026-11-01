// A deterministic test baseline. It sees adapterInput only, never reference evidence.
export async function fixtureAdapter(request, { signal } = {}) {
  signal?.throwIfAborted();
  const output = request.kind === 'instructions' ? { text: '{"fixture":true}', evidenceSource: 'controlled-test-only' }
    : { selected: request.input.labels[0], evidenceSource: 'controlled-test-only' };
  return { output, invocations: [{ adapter: 'controlled-fixture', evidenceSource: 'controlled-test-only', output }] };
}
