export const CRITERIA = ['keywords:existence', 'keywords:forbidden_words', 'detectable_format:json_format', 'startend:quotation'];
export const ADAPTERS = {
  'controlled-fixture': { taskKinds: ['choice', 'classification', 'instructions'], evidenceSource: 'controlled-test-only' },
  'cloudflare-native': { taskKinds: ['choice', 'classification'], models: ['clef', 'clef-flash'], credentialScheme: 'env', evidenceSource: 'live-provider' },
};

export function capabilities() {
  return structuredClone({
    kind: 'capabilities', contractVersion: 'decision-lab.cli/v1',
    protocolModes: ['custom', 'derived'],
    planSchema: 'urn:decision-lab:plan:v1', resultSchema: 'urn:decision-lab:result:v1',
    commands: ['capabilities', 'plan validate', 'experiment create', 'experiment get'],
    execution: { available: false, reason: 'Independent Worker is scheduled for P1.2.', automaticRetries: 0 },
    adapters: ADAPTERS,
    evaluations: { 'label-match': { revisions: ['1'], taskKinds: ['choice', 'classification'] }, ifeval: { revisions: ['1'], variants: ['strict', 'loose'], criteria: CRITERIA, taskKinds: ['instructions'] } },
    limits: { maxCases: 10000, maxRepeats: 100, maxPlanBytes: 8388608 },
    credentialResolution: 'process-environment-only; no automatic .env loading; preflight never contacts providers',
    deployment: 'single-machine trusted-operator; project scoping is not authentication',
  });
}
