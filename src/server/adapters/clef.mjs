const makeError = (code, message) => Object.assign(new Error(message), { code });
export function clefRequest(request, model = 'clef') {
  if (!['clef','clef-flash'].includes(model)) throw makeError('UNSUPPORTED_MODEL','Select clef or clef-flash');
  if (!['choice','classification'].includes(request.kind)) throw makeError('UNSUPPORTED_TASK','CLEF native adapter supports categorical tasks, not text generation');
  const { input } = request;
  const criteria = Object.fromEntries(input.labels.map(label => [label, request.kind === 'choice'
    ? input.candidates.find(candidate => candidate.id === label)?.text || label
    : label === 'oos' ? 'Out of scope: none of the supported intents matches the utterance.' : label.replaceAll('_',' ')]));
  return { model, state: request.kind === 'choice' ? input.prompt : { utterance: input.text }, questions: {
    decision: { type:'choice', instructions:request.kind === 'choice'
      ? 'Select the correct option for the final multiple-choice question. Earlier answered questions are demonstrations.'
      : 'Classify the utterance into exactly one of the provided intents. Select oos when it falls outside all supported intents. Judge the actual request, not merely keyword overlap.', criteria },
  } };
}

export function createClefAdapter({ accountId, apiToken, model = 'clef', transport = fetch }) {
  if (!/^[a-f0-9]{32}$/i.test(accountId || '') || !apiToken) throw makeError('MISSING_CREDENTIALS','Configure Cloudflare credentials in .env');
  return async (request, { signal } = {}) => {
    const payload = clefRequest(request, model), started = performance.now();
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    let response;
    try { response = await transport(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`, {
      method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${apiToken}`},body:JSON.stringify(payload),redirect:'manual',signal:requestSignal,
    }); } catch(e) { throw makeError(e.name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK','CLEF request did not return a response'); }
    const elapsedMs = Math.round(performance.now() - started);
    let originalText;
    try { originalText = await response.text(); } catch { throw makeError('UPSTREAM_BODY_INTERRUPTED', 'CLEF response body did not complete'); }
    const rawBody = originalText.split(apiToken).join('[REDACTED]').replace(/(?:cfat_|Bearer )[A-Za-z0-9_.-]+/g,'[REDACTED]');
    let data;try{data=JSON.parse(rawBody);}catch{data=null;}
    const result = data?.result, answer = result?.answers?.decision;
    const code = response.status >= 300 && response.status < 400 ? 'UPSTREAM_REDIRECT'
      : !response.ok || data?.success === false ? 'UPSTREAM_REJECTED'
      : !answer || typeof answer.choice !== 'string' ? 'INVALID_DECISION_RESPONSE' : null;
    const output = code ? { providerError:{code,httpStatus:response.status} }
      : { selected:answer.choice,...(answer.probabilities!==undefined?{probabilities:answer.probabilities}:{}),...(typeof answer.confidence==='number'?{confidence:answer.confidence}:{}),evidenceSource:answer.probabilities?'native-candidate-distribution':'native-selection' };
    return { output, invocations:[{ request:payload,httpStatus:response.status,rawBody,redacted:rawBody!==originalText,elapsedMs,model:result?.model||model,usage:result?.usage||null }] };
  };
}
